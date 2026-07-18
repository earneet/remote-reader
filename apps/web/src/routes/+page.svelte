<script lang="ts">
    let { data } = $props();
</script>

<h1>Remote Reader</h1>
<p>当前用户：{data.user?.email ?? '未登录'}</p>
<p>
    <a href="/login">登录</a> · <a href="/register">注册</a>
</p>
