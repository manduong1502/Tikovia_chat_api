#!/bin/bash
# ==============================================================================
# KỊCH BẢN SAO LƯU TỰ ĐỘNG (POSTGRESQL + LOCAL SSD UPLOADS) CHO CHATTIKOVIA
# HDSD: Đặt lịch chạy tự động lúc 02:00 sáng mỗi ngày bằng lệnh `crontab -e`:
# 0 2 * * * /bin/bash /mnt/ssd500/tiko/chattikovia-api/backup.sh >> /var/log/chattikovia-backup.log 2>&1
# ==============================================================================
set -euo pipefail

# Bản sao lưu chứa toàn bộ tin nhắn + khoá VAPID → chỉ chủ sở hữu được đọc (chmod 600)
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Chỉ đọc đúng biến DATABASE_URL từ .env (không `export $(... | xargs)` vì sẽ vỡ khi giá trị chứa ký tự đặc biệt & lộ biến khác)
DATABASE_URL="${DATABASE_URL:-}"
if [ -z "$DATABASE_URL" ] && [ -f "$SCRIPT_DIR/.env" ]; then
  DATABASE_URL="$(grep -E '^[[:space:]]*DATABASE_URL=' "$SCRIPT_DIR/.env" | tail -n1 | cut -d= -f2- | sed -e 's/^[[:space:]]*//' -e 's/^"//' -e 's/"[[:space:]]*$//' -e "s/^'//" -e "s/'[[:space:]]*$//")"
fi

if [ -z "$DATABASE_URL" ]; then
  echo "[$(date -Iseconds)] LỖI: Không tìm thấy DATABASE_URL trong môi trường hoặc $SCRIPT_DIR/.env" >&2
  exit 1
fi

BACKUP_ROOT="/mnt/ssd500/tiko/backups/chattikovia"
RETENTION_DAYS=14
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

mkdir -p "$BACKUP_ROOT/db" "$BACKUP_ROOT/uploads"

echo "[$(date -Iseconds)] === BẮT ĐẦU SAO LƯU HỆ THỐNG CHATTIKOVIA ==="

# 1. Sao lưu nóng Cơ sở dữ liệu PostgreSQL (bỏ tham số ?schema=... của Prisma vì pg_dump không hiểu)
DB_DUMP_FILE="$BACKUP_ROOT/db/chattikovia_pg_${TIMESTAMP}.dump"
PG_URI="${DATABASE_URL%%\?*}"
docker run --rm --network host postgres:16-alpine pg_dump "$PG_URI" -Fc > "$DB_DUMP_FILE"

# Kiểm tra bản dump không rỗng / không hỏng trước khi coi là thành công
if [ ! -s "$DB_DUMP_FILE" ] || [ "$(stat -c%s "$DB_DUMP_FILE")" -lt 1024 ]; then
  echo "[$(date -Iseconds)] LỖI: Bản sao lưu PostgreSQL rỗng hoặc quá nhỏ, giữ nguyên các bản cũ!" >&2
  rm -f "$DB_DUMP_FILE"
  exit 1
fi
docker run --rm -i postgres:16-alpine pg_restore --list < "$DB_DUMP_FILE" > /dev/null
echo "[$(date -Iseconds)] Đã sao lưu PostgreSQL: $DB_DUMP_FILE ($(du -h "$DB_DUMP_FILE" | cut -f1))"

# 2. Sao lưu thư mục tệp đính kèm trên ổ cứng SSD (bao gồm cả khoá VAPID .vapid.json để thông báo đẩy không bị mất)
UPLOADS_ARCHIVE="$BACKUP_ROOT/uploads/chattikovia_uploads_${TIMESTAMP}.tar.gz"
docker exec tiko-chattikovia-api tar -czf - -C /app/uploads . > "$UPLOADS_ARCHIVE"
if [ ! -s "$UPLOADS_ARCHIVE" ]; then
  echo "[$(date -Iseconds)] LỖI: Bản sao lưu uploads rỗng!" >&2
  rm -f "$UPLOADS_ARCHIVE"
  exit 1
fi
echo "[$(date -Iseconds)] Đã sao lưu SSD Uploads: $UPLOADS_ARCHIVE ($(du -h "$UPLOADS_ARCHIVE" | cut -f1))"

# 3. Chỉ dọn bản cũ SAU KHI bản mới đã thành công (luôn giữ tối thiểu 3 bản gần nhất phòng khi cron lỗi nhiều ngày)
prune_old() {
  local dir="$1" pattern="$2"
  local count
  count=$(find "$dir" -maxdepth 1 -type f -name "$pattern" | wc -l)
  if [ "$count" -gt 3 ]; then
    find "$dir" -maxdepth 1 -type f -name "$pattern" -mtime +"$RETENTION_DAYS" -delete
  fi
}
prune_old "$BACKUP_ROOT/db" "chattikovia_pg_*.dump"
prune_old "$BACKUP_ROOT/uploads" "chattikovia_uploads_*.tar.gz"

# 4. (Tuỳ chọn) Chép bản sao lưu ra ngoài server qua rclone (Google Drive / OneDrive / máy khác)
#    Bật bằng cách đặt OFFSITE_REMOTE trong .env, ví dụ: OFFSITE_REMOTE=gdrive-crypt:ChatTikovia-Backups
#    Khuyến nghị dùng remote dạng "crypt" của rclone để dữ liệu được MÃ HOÁ trước khi rời khỏi server.
OFFSITE_REMOTE="${OFFSITE_REMOTE:-}"
if [ -z "$OFFSITE_REMOTE" ] && [ -f "$SCRIPT_DIR/.env" ]; then
  OFFSITE_REMOTE="$(grep -E '^[[:space:]]*OFFSITE_REMOTE=' "$SCRIPT_DIR/.env" | tail -n1 | cut -d= -f2- | sed -e 's/^[[:space:]]*//' -e 's/^"//' -e 's/"[[:space:]]*$//')"
fi
OFFSITE_RETENTION_DAYS=30
RCLONE_CONFIG_FILE="${RCLONE_CONFIG:-/root/.config/rclone/rclone.conf}"

if [ -n "$OFFSITE_REMOTE" ]; then
  if command -v rclone > /dev/null 2>&1; then
    echo "[$(date -Iseconds)] Đang chép bản sao lưu ra ngoài: $OFFSITE_REMOTE"
    # Lỗi chép ra ngoài KHÔNG làm hỏng bản sao lưu cục bộ đã thành công
    if rclone --config "$RCLONE_CONFIG_FILE" copy "$DB_DUMP_FILE" "$OFFSITE_REMOTE/db/" --retries 3 \
       && rclone --config "$RCLONE_CONFIG_FILE" copy "$UPLOADS_ARCHIVE" "$OFFSITE_REMOTE/uploads/" --retries 3; then
      rclone --config "$RCLONE_CONFIG_FILE" delete "$OFFSITE_REMOTE/db/" --min-age "${OFFSITE_RETENTION_DAYS}d" || true
      rclone --config "$RCLONE_CONFIG_FILE" delete "$OFFSITE_REMOTE/uploads/" --min-age "${OFFSITE_RETENTION_DAYS}d" || true
      echo "[$(date -Iseconds)] Đã chép bản sao lưu ra ngoài thành công (giữ ${OFFSITE_RETENTION_DAYS} ngày)."
    else
      echo "[$(date -Iseconds)] CẢNH BÁO: Chép bản sao lưu ra ngoài thất bại (bản cục bộ vẫn an toàn)." >&2
    fi
  else
    echo "[$(date -Iseconds)] CẢNH BÁO: Đã đặt OFFSITE_REMOTE nhưng chưa cài rclone (sudo apt install rclone)." >&2
  fi
fi

echo "[$(date -Iseconds)] === HOÀN TẤT SAO LƯU AN TOÀN (LƯU TRỮ TỐI ĐA $RETENTION_DAYS NGÀY) ==="
