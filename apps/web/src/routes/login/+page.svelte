<script lang="ts">
    import { enhance } from '$app/forms';
    import AuthCard from '$components/AuthCard.svelte';
    let { form } = $props();
    let loading = $state(false);
    let submitBtn = $state<HTMLButtonElement | null>(null);
</script>

<AuthCard title="登录" error={form?.error}>
    <form
        method="POST"
        use:enhance={() => {
            loading = true;
            return async ({ update }) => {
                await update();
                loading = false;
                // disabled 会把焦点抛回 body——失败后归还，键盘用户 Enter 重提交链不断
                submitBtn?.focus();
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
        <button type="submit" class="submit" bind:this={submitBtn} disabled={loading}>登录</button>
    </form>
    {#snippet footer()}
        没有账号？<a href="/register">注册</a>
    {/snippet}
</AuthCard>
