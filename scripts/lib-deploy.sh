# lib-deploy.sh —— install.sh / update.sh 共用的部署辅助函数（单源防漂移，同 gen-unit.sh 先例）
# 用法：在调用方定义好 log/ok/warn/die 之后 source 本文件。
# 注意：本文件只定义函数，不在顶层执行任何命令。

# 与 adapter-node files/utils.js parse_as_bytes 及 startup-check.ts parseBodySizeLimitBytes 同语义：
# 尾字符 K/M/G（大小写不敏感）按 1024 进制，其余按纯数字字节。
# 空或非法输入按 adapter-node 默认值 512K（524288）返回——与启动校验的兜底一致。
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
#   max(MAX_UPLOAD_BYTES × 1.5, ceil(MAX_IMAGE_BYTES × 1.37 × 1.5))
# 全程整数算术：×1.5 = ×3/2；×1.37×1.5 = ×2055/1000 后向上取整。
required_body_size_limit() {
    local upload="$1" image="$2"
    local a=$(( upload * 3 / 2 ))
    local b=$(( (image * 2055 + 999) / 1000 ))
    (( a >= b )) && echo "${a}" || echo "${b}"
}

# 向上取整到 MiB 边界（迁移写入值，保证 ≥ 下限且为整 MiB，便于人工阅读）
round_up_mib() {
    echo $(( ($1 + 1048575) / 1048576 * 1048576 ))
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
