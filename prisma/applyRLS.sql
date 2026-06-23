-- APPLY ROW LEVEL SECURITY (RLS) FOR CHATTIKOVIA IN POSTGRESQL
-- Tài liệu hướng dẫn: Chạy script này trực tiếp trên cơ sở dữ liệu PostgreSQL sau khi đã chạy Prisma migration.

-- 1. Bật tính năng RLS trên các bảng dữ liệu nhạy cảm
ALTER TABLE "ConversationMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Reminder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PushSubscription" ENABLE ROW LEVEL SECURITY;

-- Dọn dẹp các policy và function cũ nếu có để tránh lỗi trùng lặp
DROP POLICY IF EXISTS member_access ON "ConversationMember";
DROP POLICY IF EXISTS message_access ON "Message";
DROP POLICY IF EXISTS reminder_access ON "Reminder";
DROP POLICY IF EXISTS push_subscription_access ON "PushSubscription";
DROP FUNCTION IF EXISTS check_conversation_member;

-- 2. Tạo hàm kiểm tra thành viên với SECURITY DEFINER để phá vỡ đệ quy vô hạn (Infinite Recursion)
-- Hàm này sẽ chạy dưới quyền của Owner (thường là superuser/bypassrls) để đọc bảng ConversationMember mà không kích hoạt RLS.
CREATE OR REPLACE FUNCTION check_conversation_member(conv_id text, user_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM "ConversationMember"
    WHERE "conversationId" = conv_id AND "userId" = user_id
  );
END;
$$;

-- 3. Thiết lập chính sách bảo mật (Policies) dựa trên biến môi trường cục bộ 'app.current_user_id'

-- CHÍNH SÁCH BẢNG ConversationMember (Thành viên cuộc trò chuyện):
-- Cho phép thao tác nếu bản ghi đó thuộc về chính mình, hoặc mình nằm trong nhóm chat đó (sử dụng hàm check_conversation_member để tránh đệ quy).
CREATE POLICY member_access ON "ConversationMember"
  FOR ALL
  USING (
    "userId" = current_setting('app.current_user_id', true)
    OR check_conversation_member("conversationId", current_setting('app.current_user_id', true))
  );

-- CHÍNH SÁCH BẢNG Message (Tin nhắn):
-- Chỉ thành viên của cuộc trò chuyện mới được phép đọc/ghi/sửa/xóa tin nhắn của cuộc trò chuyện đó.
CREATE POLICY message_access ON "Message"
  FOR ALL
  USING (
    check_conversation_member("conversationId", current_setting('app.current_user_id', true))
  );

-- CHÍNH SÁCH BẢNG Reminder (Nhắc hẹn):
-- Chỉ người tạo nhắc hẹn hoặc thành viên trong phòng chat liên quan mới được truy cập.
CREATE POLICY reminder_access ON "Reminder"
  FOR ALL
  USING (
    "creatorId" = current_setting('app.current_user_id', true)
    OR EXISTS (
      SELECT 1 FROM "Message" m
      WHERE m.id = "Reminder"."messageId"
      AND check_conversation_member(m."conversationId", current_setting('app.current_user_id', true))
    )
  );

-- CHÍNH SÁCH BẢNG PushSubscription (Thông báo đẩy):
-- Chỉ người sở hữu mới được thao tác các token thông báo của mình.
CREATE POLICY push_subscription_access ON "PushSubscription"
  FOR ALL
  USING (
    "userId" = current_setting('app.current_user_id', true)
  );
