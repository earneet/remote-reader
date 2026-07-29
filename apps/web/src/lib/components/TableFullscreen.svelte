<script lang="ts">
    let { container, html }: { container: HTMLDivElement | undefined; html: string } = $props();

    $effect(() => {
        const _ = html;
        const root = container;
        if (!root) return;
        const wraps = Array.from(root.querySelectorAll<HTMLElement>('.rr-table-wrap'));
        const apply = (w: HTMLElement) => {
            const t = w.querySelector('table');
            if (!t) return;
            w.classList.remove('rr-shrink', 'rr-wide');
            const overflow = () => t.scrollWidth > w.clientWidth + 8;
            if (!overflow()) return;
            if (window.matchMedia('(max-width: 768px)').matches) {
                w.classList.add('rr-shrink');
                if (overflow()) w.classList.add('rr-wide');
            } else {
                w.classList.add('rr-wide');
            }
        };
        wraps.forEach(apply);
        let raf = 0;
        const rerun = () => {
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(() => wraps.forEach(apply));
        };
        const ro = new ResizeObserver(() => rerun());
        ro.observe(root);
        window.addEventListener('resize', rerun);
        return () => {
            cancelAnimationFrame(raf);
            ro.disconnect();
            window.removeEventListener('resize', rerun);
        };
    });
</script>
