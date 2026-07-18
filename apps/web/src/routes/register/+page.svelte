<script lang="ts">
    import { enhance } from '$app/forms';
    let loading = $state(false);
</script>

<h1>注册</h1>
<form
    method="POST"
    use:enhance={() => {
        loading = true;
        return async ({ update }) => {
            await update();
            loading = false;
        };
    }}
>
    <label>邮箱 <input name="email" type="email" required /></label><br />
    <label>密码 <input name="password" type="password" required /></label><br />
    <label>邀请码 <input name="invite_code" required /></label><br />
    <button disabled={loading}>注册</button>
</form>
<p><a href="/login">已有账号？登录</a></p>
