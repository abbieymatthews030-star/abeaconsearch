#!/usr/bin/env sh
# Snapshot the Beacon Search data volume to a timestamped tarball.
#
#   sudo deploy/backup.sh
#
# Cron (daily at 03:30, keep 14):
#   30 3 * * *  /opt/abeaconsearch/deploy/backup.sh >> /var/log/beacon-backup.log 2>&1
#
# Restore:
#   docker compose -f docker-compose.prod.yml down
#   docker run --rm -v beacon-search_beacon-data:/data -v "$PWD":/backup alpine:3 \
#     sh -c 'rm -rf /data/* && tar xzf /backup/beacon-<STAMP>.tar.gz -C /data'
#   docker compose -f docker-compose.prod.yml up -d

set -eu

VOLUME="${BEACON_VOLUME:-beacon-search_beacon-data}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/beacon}"
KEEP="${KEEP:-14}"

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/beacon-$stamp.tar.gz"

docker run --rm \
	-v "$VOLUME":/data:ro \
	-v "$BACKUP_DIR":/backup \
	alpine:3 tar czf "/backup/beacon-$stamp.tar.gz" -C /data .

# Prune all but the newest $KEEP archives.
ls -1t "$BACKUP_DIR"/beacon-*.tar.gz 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r old; do
	rm -f "$old"
done

echo "backup written: $out ($(du -h "$out" | cut -f1))"
