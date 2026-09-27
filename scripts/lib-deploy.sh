# lib-deploy.sh —— install.sh / update.sh 共用的部署辅助函数（单源防漂移，同 gen-unit.sh 先例）
# 用法：在调用方定义好 log/ok/warn/die 之后 source 本文件。
# 注意：本文件只定义函数，不在顶层执行任何命令。

# 与 adapter-node files/utils.js parse_as_bytes 及 startup-check.ts parseBodySizeLimitBytes 同语义：
# 尾字符 K/M/G（大小写不敏感）按 1024 进制，其余按纯数字字节。
# 空输入按 adapter-node 默认值 512K（524288）返回。非空非法值（如 20.5M 小数）同回落 512K：
# 方向安全（只会触发一次有备份的 BODY_SIZE_LIMIT 迁移）——注意与生产端语义不同，
# startup-check 对非法值是 NaN fail-fast 拒启（而非兜底），最终一致由服务端守门。
parse_size_bytes() {
    local raw="${1:-}"
    raw="$(printf '%s' "${raw}" | tr -d '[:space:]')"
    [[ -n "${raw}" ]] || { echo 524288; return; }
    local last="${raw: -1}" mult=1 num="${raw}"
    case "${last^^}" in
        K) mult=1024;        num="${raw:0:-1}" ;;
        M) mult=1048576;     num="${raw:0:-1}" ;;
        G) mult=1073741824;  num="${raw:0:-1}" ;;
    esac
    [[ "${num}" =~ ^[0-9]+$ ]] || { echo 524288; return; }
    echo $(( num * mult ))
}

# BODY_SIZE_LIMIT 启动校验下限，与 apps/web/src/lib/server/startup-check.ts 同公式：
#   max(MAX_UPLOAD_BYTES × 1.5, Math.ceil(MAX_IMAGE_BYTES × 1.37 × 1.5))
# 全程整数算术：×1.5 = ×3/2 后向上取整；×1.37×1.5 = ×2055/1000 后**再 +1** 取整。
# +1 的必要性（验收第 2 轮数值扫描实证）：JS 侧是 double 运算，image×1.37×1.5 的浮点积在
# 精确有理数恰为整数时可上偏（如 i=600：822.0000000000001×1.5 → ceil 1234 > 精确 ceil 1233，
# 1746 万组合中 18284 对差 1）——bash 精确 ceil 可能比 JS Math.ceil 少 1，env 恰设为 bash 值时
# 服务端仍拒启。+1 使 bash 恒 ≥ JS（误差上界恰为 1），round_up_mib 的 MiB 富余吸收这 1 字节。
required_body_size_limit() {
    local upload="$1" image="$2"
    local a=$(( (upload * 3 + 1) / 2 ))
    local b=$(( (image * 2055 + 1999) / 1000 ))
    (( a >= b )) && echo "${a}" || echo "${b}"
}

# 向上取整到 MiB 边界（迁移写入值，保证 ≥ 下限且为整 MiB，便于人工阅读）
round_up_mib() {
    echo $(( ($1 + 1048575) / 1048576 * 1048576 ))
}

# SRC_DIR==INSTALL_DIR 守卫（2026-09-23 实证）：SRC_DIR 由脚本自身路径推导，
# 在部署目录里跑 ./scripts/update.sh 会自我 rsync 旧源码"假升级"——构建与
# 健康检查全过，但部署的是部署目录里的旧码。必须在 rsync/构建前拦截。
# 用法：die_if_src_is_install_dir <src_dir> <install_dir>
die_if_src_is_install_dir() {
    local src="$1" dst="$2"
    [[ -d "${dst}" ]] && dst="$(cd "${dst}" && pwd)"
    dst="${dst%/}"
    if [[ "${src}" == "${dst}" ]]; then
        die "源码目录与安装目录相同（${src}）——本脚本以自身位置推导源码目录，在部署目录内执行会自我 rsync 旧代码（假升级）。请 cd 到源码克隆目录后重跑"
    fi
}

# bun install 产出的 better-sqlite3 prebuilt 跟随 bun 内置 node 的 ABI（如 bun 1.3.x = ABI 137），
# 与生产 /usr/bin/node（如 node 22 = ABI 127）不匹配时服务起不来（ERR_DLOPEN_FAILED）。
# 本函数用生产 node 实测加载；失败则按生产 node 的 ABI 从 npmmirror 二进制镜像
# （回退 GitHub releases）拉取对应 prebuilt 替换，替换后复测。
# 用法：fix_better_sqlite3_abi <install_dir> <node_bin>
# 返回：0 = 可加载（原本正常或已修复）；1 = 不可用且自动修复失败（调用方决定 die 或 warn）。
fix_better_sqlite3_abi() {
    local install_dir="$1" node_bin="$2"
    local pkg_dir="" cand

    # bun 1.3.x 隔离布局：node_modules/.bun/better-sqlite3@<ver>/node_modules/better-sqlite3
    # 经典布局：node_modules/better-sqlite3
    for cand in "${install_dir}"/node_modules/.bun/better-sqlite3@*/node_modules/better-sqlite3 \
                "${install_dir}/node_modules/better-sqlite3"; do
        if [[ -f "${cand}/package.json" ]]; then pkg_dir="${cand}"; break; fi
    done
    if [[ -z "${pkg_dir}" ]]; then
        warn "未找到 better-sqlite3 包目录，跳过 ABI 检测"
        return 1
    fi

    # 实测加载（:memory: 开库 + 一条查询，覆盖 .node 加载与基本调用路径）
    local probe='const D=require(process.argv[1]);const db=new D(":memory:");db.prepare("SELECT 1").get();db.close();'
    if "${node_bin}" -e "${probe}" "${pkg_dir}" >/dev/null 2>&1; then
        ok "better-sqlite3 与生产 node ABI 匹配（无需修复）"
        return 0
    fi

    local abi ver platform arch
    abi="$("${node_bin}" -p 'process.versions.modules')"
    ver="$("${node_bin}" -p 'require(process.argv[1]).version' "${pkg_dir}/package.json")"
    case "$(uname -s)" in
        Linux)  platform=linux ;;
        Darwin) platform=darwin ;;
        *) warn "未知平台 $(uname -s)，无法自动修复 better-sqlite3 ABI"; return 1 ;;
    esac
    case "$(uname -m)" in
        x86_64|amd64)  arch=x64 ;;
        aarch64|arm64) arch=arm64 ;;
        *) warn "未知架构 $(uname -m)，无法自动修复 better-sqlite3 ABI"; return 1 ;;
    esac

    warn "better-sqlite3 v${ver} 与生产 node（ABI ${abi}）不匹配，自动拉取对应 prebuilt 替换…"
    local fname="better-sqlite3-v${ver}-node-v${abi}-${platform}-${arch}.tar.gz"
    local tmp
    tmp="$(mktemp)" || return 1
    local url ok_dl=0
    for url in \
        "https://registry.npmmirror.com/-/binary/better-sqlite3/v${ver}/${fname}" \
        "https://github.com/WiseLibs/better-sqlite3/releases/download/v${ver}/${fname}"; do
        if curl -fsSL --connect-timeout 10 --max-time 120 -o "${tmp}" "${url}" 2>/dev/null; then
            ok_dl=1; break
        fi
    done
    if [[ "${ok_dl}" -ne 1 ]]; then
        rm -f "${tmp}"
        warn "prebuilt 下载失败（npmmirror 与 GitHub 均不可达/无此 ABI 包）"
        return 1
    fi
    if ! tar -xzf "${tmp}" -C "${pkg_dir}"; then
        rm -f "${tmp}"
        warn "prebuilt 解压失败"
        return 1
    fi
    rm -f "${tmp}"

    if "${node_bin}" -e "${probe}" "${pkg_dir}" >/dev/null 2>&1; then
        ok "better-sqlite3 已替换为 node ABI ${abi} prebuilt 并验证可加载"
        return 0
    fi
    warn "替换后仍无法加载 better-sqlite3"
    return 1
}


# rsync 排除清单（R-11 单源）：install.sh 与 update.sh 原先逐字两份——新增 workspace 或
# 改构建产物路径漏改一处即 install 与 update 部署出不同产物（BODY_SIZE_LIMIT 公式当年漂移同险）。
rsync_source_tree() {
    rsync -a --delete \
        --exclude '/data' \
        --exclude '/node_modules' \
        --exclude '/apps/web/node_modules' \
        --exclude '/apps/web/build' \
        --exclude '/apps/web/.svelte-kit' \
        --exclude '/packages/shared/node_modules' \
        --exclude '/apps/mcp-bridge/node_modules' \
        --exclude '/apps/mcp-bridge/dist' \
        --exclude '/.git' \
        --exclude '/.env' \
        --exclude '/.env.local' \
        "$1/" "$2/"
}

# 构建 + 剥离 devDeps + ABI 自修（R-11 单源）：与 rsync 同因的两份 ~20 行重复序列。
# 调用方保留自己的 log/die 文案；返回值 = 0 全链成功 / 1 任一步失败（调用方 die + 回滚）。
# ⚠️ 各步骤必须显式 || return 1：本函数被调用方置于 `if !` 条件上下文，bash 对条件上下文中
# 调用的函数体整体抑制 errexit（bash FAQ E4）——set -e 不再兜底。审查实证：无显式判失败时
# bun install/构建瞬态失败会带谎 ✓ 日志继续跑，update.sh 场景可至「旧 build 残留 + health 跑
# 旧代码通过」的静默假升级（rsync 排除项同时保护旧 build 与旧 node_modules 不被 --delete 清除）。
build_and_prune() {
    local install_dir="$1" bun_bin="$2" node_bin="$3"
    export BUN_INSTALL_CACHE_DIR=/tmp/.bun-cache
    mkdir -p "${BUN_INSTALL_CACHE_DIR}" || return 1
    (cd "${install_dir}" && "${bun_bin}" install) || { warn "bun install 失败"; return 1; }
    ok "依赖已安装"
    (cd "${install_dir}" && "${bun_bin}" --filter remote-reader-web build) || { warn "web 构建失败"; return 1; }
    ok "构建完成"
    # 剥离 devDependencies（vite build 已把 workspace 依赖内联到 build/server）；
    # 保留 bun.lock：删了它二次 install 会重新解析依赖树，结果随 registry 漂移且慢
    (cd "${install_dir}" && rm -rf node_modules apps/web/node_modules packages/shared/node_modules apps/mcp-bridge/node_modules) || { warn "devDeps 剥离失败"; return 1; }
    (cd "${install_dir}" && "${bun_bin}" install --production) || { warn "生产依赖安装失败"; return 1; }
    ok "生产依赖就绪"
    fix_better_sqlite3_abi "${install_dir}" "${node_bin}"
}
