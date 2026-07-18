<script lang="ts">
    import { enhance } from '$app/forms';
    let loading = $state(false);
</script>

<h1>登录</h1>
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
    <button disabled={loading}>登录</button>
</form>
<p><a href="/register">没有账号？注册</a></p>
