<script lang="ts">
    import { enhance } from '$app/forms';
    let { form } = $props();
    let loading = $state(false);
</script>

<div class="auth-page">
    <div class="card">
        <div class="brand">
            <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#0969da"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
            >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="8" y1="13" x2="16" y2="13" />
                <line x1="8" y1="17" x2="13" y2="17" />
            </svg>
            <span class="brand-name">Remote Reader</span>
        </div>

        <h1 class="title">注册</h1>

        {#if form?.error}
            <div class="alert" role="alert">{form.error}</div>
        {/if}

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
                    autocomplete="new-password"
                />
            </div>
            <div class="field">
                <label for="invite_code">邀请码</label>
                <input id="invite_code" name="invite_code" required />
            </div>
            <button type="submit" class="submit" disabled={loading}>注册</button>
        </form>

        <p class="footer">已有账号？<a href="/login">登录</a></p>
    </div>
</div>

<style>
    .auth-page {
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--rr-bg);
        font-family: system-ui, -apple-system, sans-serif;
        padding: 1rem;
    }

    .card {
        width: min(380px, calc(100vw - 2rem));
        background: var(--rr-card-bg);
        border: 1px solid var(--rr-card-border);
        border-radius: 12px;
        box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
        padding: 2.5rem;
        box-sizing: border-box;
    }

    .brand {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        margin-bottom: 1.5rem;
    }

    .brand-name {
        font-size: 1.25rem;
        font-weight: 600;
        color: var(--rr-text);
    }

    .title {
        margin: 0 0 0.5rem;
        text-align: center;
        font-size: 1.5rem;
        font-weight: 600;
        color: var(--rr-text);
    }

    .alert {
        margin: 0;
        background: var(--rr-danger-soft);
        border: 1px solid var(--rr-danger-border);
        border-radius: 6px;
        padding: 0.6rem 0.75rem;
        color: var(--rr-danger);
        font-size: 0.9rem;
    }

    form {
        display: flex;
        flex-direction: column;
        gap: 1rem;
        margin-top: 1rem;
    }

    .field {
        display: flex;
        flex-direction: column;
    }

    label {
        display: block;
        font-size: 0.875rem;
        font-weight: 500;
        color: var(--rr-text);
        margin-bottom: 0.375rem;
    }

    input {
        width: 100%;
        padding: 0.6rem 0.75rem;
        border: 1px solid var(--rr-input-border);
        border-radius: 6px;
        font-size: 0.95rem;
        box-sizing: border-box;
        background: var(--rr-input-bg);
        color: var(--rr-text);
        font-family: inherit;
    }

    input:focus {
        outline: none;
        border-color: var(--rr-accent);
        box-shadow: 0 0 0 3px var(--rr-focus-ring);
    }

    .submit {
        width: 100%;
        margin-top: 1.25rem;
        padding: 0.65rem 1rem;
        background: var(--rr-accent);
        color: #ffffff;
        border: none;
        border-radius: 6px;
        font-size: 0.95rem;
        font-weight: 500;
        cursor: pointer;
        font-family: inherit;
    }

    .submit:hover {
        background: var(--rr-accent-hover);
    }

    .submit:disabled {
        opacity: 0.6;
        cursor: not-allowed;
    }

    .footer {
        margin-top: 1.25rem;
        text-align: center;
        font-size: 0.875rem;
        color: var(--rr-text-muted);
    }

    .footer a {
        color: var(--rr-link);
        text-decoration: none;
    }

    .footer a:hover {
        text-decoration: underline;
    }
</style>
