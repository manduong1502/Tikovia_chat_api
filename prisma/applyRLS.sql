-- APPLY ROW LEVEL SECURITY (RLS) FOR CHATTIKOVIA IN POSTGRESQL
-- Tài liệu hướng dẫn: Script này cấu hình RLS an toàn cho PostgreSQL 16.
-- Khi kết nối từ Prisma Pooler (chưa đặt biến phiên 'app.current_user_id' hoặc đặt là 'system'),
-- truy vấn từ Backend đã xác thực JWT được phép thực thi mượt mà.
-- Khi 'app.current_user_id' được đặt thành một userId cụ thể, PostgreSQL sẽ kiểm tra chặt chẽ quyền truy cập dòng.

-- 1. Bật tính năng RLS trên các bảng dữ liệu nhạy cảm
ALTER TABLE "ConversationMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Reminder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PushSubscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Task" ENABLE ROW LEVEL SECURITY;

-- Dọn dẹp các policy và function cũ nếu có để tránh lỗi trùng lặp
DROP POLICY IF EXISTS member_access ON "ConversationMember";
DROP POLICY IF EXISTS message_access ON "Message";
DROP POLICY IF EXISTS reminder_access ON "Reminder";
DROP POLICY IF EXISTS push_subscription_access ON "PushSubscription";
DROP POLICY IF EXISTS task_access ON "Task";
DROP FUNCTION IF EXISTS check_conversation_member;
DROP FUNCTION IF EXISTS is_system_or_unset_context;

-- 2. Hàm kiểm tra xem biến ngữ cảnh có đang ở chế độ Backend System / Pooler mặc định hay không
CREATE OR REPLACE FUNCTION is_system_or_unset_context()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(NULLIF(current_setting('app.current_user_id', true), ''), 'system') = 'system';
$$;

-- 3. Tạo hàm kiểm tra thành viên với SECURITY DEFINER để tránh đệ quy vô hạn (Infinite Recursion)
CREATE OR REPLACE FUNCTION check_conversation_member(conv_id text, user_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF conv_id IS NULL OR user_id IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM "ConversationMember"
    WHERE "conversationId" = conv_id AND "userId" = user_id
  );
END;
$$;

-- 4. Thiết lập chính sách bảo mật (Policies)

-- CHÍNH SÁCH BẢNG ConversationMember:
CREATE POLICY member_access ON "ConversationMember"
  FOR ALL
  USING (
    is_system_or_unset_context()
    OR "userId" = current_setting('app.current_user_id', true)
    OR check_conversation_member("conversationId", current_setting('app.current_user_id', true))
  );

-- CHÍNH SÁCH BẢNG Message:
CREATE POLICY message_access ON "Message"
  FOR ALL
  USING (
    is_system_or_unset_context()
    OR check_conversation_member("conversationId", current_setting('app.current_user_id', true))
  );

-- CHÍNH SÁCH BẢNG Reminder:
CREATE POLICY reminder_access ON "Reminder"
  FOR ALL
  USING (
    is_system_or_unset_context()
    OR "creatorId" = current_setting('app.current_user_id', true)
    OR ("conversationId" IS NOT NULL AND check_conversation_member("conversationId", current_setting('app.current_user_id', true)))
    OR EXISTS (
      SELECT 1 FROM "Message" m
      WHERE m.id = "Reminder"."messageId"
      AND check_conversation_member(m."conversationId", current_setting('app.current_user_id', true))
    )
  );

-- CHÍNH SÁCH BẢNG PushSubscription:
CREATE POLICY push_subscription_access ON "PushSubscription"
  FOR ALL
  USING (
    is_system_or_unset_context()
    OR "userId" = current_setting('app.current_user_id', true)
  );

-- CHÍNH SÁCH BẢNG Task:
CREATE POLICY task_access ON "Task"
  FOR ALL
  USING (
    is_system_or_unset_context()
    OR check_conversation_member("conversationId", current_setting('app.current_user_id', true))
  );
