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

echo "[$(date -Iseconds)] === HOÀN TẤT SAO LƯU AN TOÀN (LƯU TRỮ TỐI ĐA $RETENTION_DAYS NGÀY) ==="
