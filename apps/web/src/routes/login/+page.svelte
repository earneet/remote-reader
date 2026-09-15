<script lang="ts">
    import { enhance } from '$app/forms';
    import AuthCard from '$components/AuthCard.svelte';
    let { form } = $props();
    let loading = $state(false);
</script>

<AuthCard title="登录" error={form?.error}>
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
        <div class="field">
            <label for="email">邮箱</label>
            <input id="email" name="email" type="email" required autocomplete="email" />
        </div>
        <div class="field">
            <label for="password">密码</label>
            <input
                id="password"
                name="password"
                type="password"
                required
                autocomplete="current-password"
            />
        </div>
        <button type="submit" class="submit" disabled={loading}>登录</button>
    </form>
    {#snippet footer()}
        没有账号？<a href="/register">注册</a>
    {/snippet}
</AuthCard>
