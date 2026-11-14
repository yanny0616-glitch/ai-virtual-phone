-- 已经建好库的话，在 Supabase SQL Editor 里单独执行这一份即可（可重复执行）。
-- 新建库直接跑 account-supabase.sql / black-market-supabase.sql / supabase-all-in-one.sql，里面已包含同样的语句。

-- 安全修复：security definer 函数默认对 anon 可调用，anon key 又是公开的，
-- 不收权限的话任何人都能绕过站点限流，直接调 /rpc/app_register_account 试激活码。
revoke all on function public.app_register_account(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.app_register_account(text, text, text, text, text) to service_role;

-- 安全修复：这些都是 security definer 函数，Supabase 默认允许 anon/authenticated 通过
-- /rest/v1/rpc/ 直接调用，而 anon key 是公开在前端的。不收权限的话，任何人都能用别人的
-- user_id 签到刷积分、替别人购买剧本扣别人的积分。只留给服务端用的 service_role。
revoke all on function public.black_market_ensure_wallet(text, text) from public, anon, authenticated;
revoke all on function public.black_market_checkin(text, text) from public, anon, authenticated;
revoke all on function public.black_market_purchase_theater(text, text, text) from public, anon, authenticated;
grant execute on function public.black_market_ensure_wallet(text, text) to service_role;
grant execute on function public.black_market_checkin(text, text) to service_role;
grant execute on function public.black_market_purchase_theater(text, text, text) to service_role;
