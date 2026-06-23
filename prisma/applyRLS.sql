-- APPLY ROW LEVEL SECURITY (RLS) FOR CHATTIKOVIA IN POSTGRESQL
-- Tài liệu hướng dẫn: Chạy script này trực tiếp trên cơ sở dữ liệu PostgreSQL sau khi đã chạy Prisma migration.

-- 1. Bật tính năng RLS trên các bảng dữ liệu nhạy cảm
ALTER TABLE "ConversationMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Reminder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PushSubscription" ENABLE ROW LEVEL SECURITY;

-- Dọn dẹp các policy cũ nếu có để tránh lỗi trùng lặp
DROP POLICY IF EXISTS member_access ON "ConversationMember";
DROP POLICY IF EXISTS message_access ON "Message";
DROP POLICY IF EXISTS reminder_access ON "Reminder";
DROP POLICY IF EXISTS push_subscription_access ON "PushSubscription";

-- 2. Thiết lập chính sách bảo mật dựa trên biến môi trường cục bộ 'app.current_user_id'

-- CHÍNH SÁCH BẢNG ConversationMember (Thành viên cuộc trò chuyện):
-- Cho phép thao tác nếu bản ghi đó thuộc về chính mình, hoặc mình nằm trong nhóm chat đó.
CREATE POLICY member_access ON "ConversationMember"
  FOR ALL
  USING (
    "userId" = current_setting('app.current_user_id', true)
    OR "conversationId" IN (
      SELECT "conversationId" FROM "ConversationMember" 
      WHERE "userId" = current_setting('app.current_user_id', true)
    )
  );

-- CHÍNH SÁCH BẢNG Message (Tin nhắn):
-- Chỉ thành viên của cuộc trò chuyện mới được phép đọc/ghi/sửa/xóa tin nhắn của cuộc trò chuyện đó.
CREATE POLICY message_access ON "Message"
  FOR ALL
  USING (
    "conversationId" IN (
      SELECT "conversationId" FROM "ConversationMember" 
      WHERE "userId" = current_setting('app.current_user_id', true)
    )
  );

-- CHÍNH SÁCH BẢNG Reminder (Nhắc hẹn):
-- Chỉ người tạo nhắc hẹn hoặc thành viên trong phòng chat liên quan mới được truy cập.
CREATE POLICY reminder_access ON "Reminder"
  FOR ALL
  USING (
    "creatorId" = current_setting('app.current_user_id', true)
    OR "messageId" IN (
      SELECT m.id FROM "Message" m
      INNER JOIN "ConversationMember" cm ON m."conversationId" = cm."conversationId"
      WHERE cm."userId" = current_setting('app.current_user_id', true)
    )
  );

-- CHÍNH SÁCH BẢNG PushSubscription (Thông báo đẩy):
-- Chỉ người sở hữu mới được thao tác các token thông báo của mình.
CREATE POLICY push_subscription_access ON "PushSubscription"
  FOR ALL
  USING (
    "userId" = current_setting('app.current_user_id', true)
  );
