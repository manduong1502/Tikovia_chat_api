#!/bin/bash
# ==============================================================================
# KỊCH BẢN SAO LƯU TỰ ĐỘNG (POSTGRESQL + LOCAL SSD UPLOADS) CHO CHATTIKOVIA
# HDSD: Đặt lịch chạy tự động lúc 02:00 sáng mỗi ngày bằng lệnh `crontab -e`:
# 0 2 * * * /bin/bash /mnt/ssd500/tiko/chattikovia-api/backup.sh >> /var/log/chattikovia-backup.log 2>&1
# ==============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/.env" ]; then
  export $(grep -v '^#' "$SCRIPT_DIR/.env" | xargs)
fi

BACKUP_ROOT="/mnt/ssd500/tiko/backups/chattikovia"
RETENTION_DAYS=14
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

mkdir -p "$BACKUP_ROOT/db"
mkdir -p "$BACKUP_ROOT/uploads"

echo "[$(date -Iseconds)] === BẮT ĐẦU SAO LƯU HỆ THỐNG CHATTIKOVIA ==="

# 1. Sao lưu nóng Cơ sở dữ liệu PostgreSQL (192.168.1.200:5433)
DB_DUMP_FILE="$BACKUP_ROOT/db/chattikovia_pg_${TIMESTAMP}.dump"
PG_URI="${DATABASE_URL%%\?*}"
docker run --rm postgres:16-alpine pg_dump "$PG_URI" -Fc > "$DB_DUMP_FILE"
echo "[$(date -Iseconds)] Đã sao lưu PostgreSQL: $DB_DUMP_FILE ($(du -h "$DB_DUMP_FILE" | cut -f1))"

# 2. Sao lưu thư mục tệp đính kèm trên ổ cứng SSD (Container tiko-chattikovia-api:/app/uploads)
UPLOADS_ARCHIVE="$BACKUP_ROOT/uploads/chattikovia_uploads_${TIMESTAMP}.tar.gz"
docker exec tiko-chattikovia-api tar -czf - -C /app/uploads . > "$UPLOADS_ARCHIVE"
echo "[$(date -Iseconds)] Đã sao lưu SSD Uploads: $UPLOADS_ARCHIVE ($(du -h "$UPLOADS_ARCHIVE" | cut -f1))"

# 3. Tự động dọn dẹp các bản sao lưu cũ quá 14 ngày để bảo vệ dung lượng SSD
find "$BACKUP_ROOT/db" -type f -name "*.dump" -mtime +$RETENTION_DAYS -delete
find "$BACKUP_ROOT/uploads" -type f -name "*.tar.gz" -mtime +$RETENTION_DAYS -delete

echo "[$(date -Iseconds)] === HOÀN TẤT SAO LƯU AN TOÀN (LƯU TRỮ TỐI ĐA $RETENTION_DAYS NGÀY) ==="
