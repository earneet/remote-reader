<script lang="ts">
    import { enhance } from '$app/forms';
    import AuthCard from '$components/AuthCard.svelte';
    let { form } = $props();
    let loading = $state(false);
    let submitBtn = $state<HTMLButtonElement | null>(null);
</script>

<AuthCard title="注册" error={form?.error}>
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
                autocomplete="new-password"
            />
        </div>
        <div class="field">
            <label for="invite_code">邀请码</label>
            <input id="invite_code" name="invite_code" required />
        </div>
        <button type="submit" class="submit" bind:this={submitBtn} disabled={loading}>注册</button>
    </form>
    {#snippet footer()}
        已有账号？<a href="/login">登录</a>
    {/snippet}
</AuthCard>
