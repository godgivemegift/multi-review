// 纯逻辑:从 nightly release 判断「是否有更新的构建」。抽出来不依赖 electron，便于单测。

// 当前平台对应的安装包资产。mac=.dmg / win=.exe / linux=.AppImage，优先匹配 CPU 架构。
export function pickAsset(assets, platform = process.platform, arch = process.arch) {
  const ext = platform === 'darwin' ? '.dmg' : platform === 'win32' ? '.exe' : '.appimage'
  const archTok = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : arch
  const byExt = (assets || []).filter((a) => (a.name || '').toLowerCase().endsWith(ext))
  return byExt.find((a) => (a.name || '').toLowerCase().includes(archTok)) || byExt[0] || null
}

// 从 release 说明里解析短 sha:"Rolling build ... (abc1234)"。
export function parseRemoteSha(body) {
  const m = (body || '').match(/\(([0-9a-f]{7,40})\)/i)
  return m ? m[1].toLowerCase() : null
}

// 是否有更新的构建:sha 不同 且 资产更新时间晚于本地构建时间。
// 同 sha → 一律不提示(避免运行的正是该 nightly 时因秒级时间差误报)。
export function computeUpdate(build, release, platform = process.platform, arch = process.arch) {
  const asset = pickAsset(release.assets, platform, arch)
  const remoteSha = parseRemoteSha(release.body)
  const ourSha = build.sha ? build.sha.toLowerCase() : null
  if (remoteSha && ourSha && ourSha.startsWith(remoteSha)) return { asset, update: false, remoteSha }

  const assetTime = asset ? Date.parse(asset.updated_at) : NaN
  const ourTime = Date.parse(build.time)
  const newer = Number.isFinite(assetTime) && Number.isFinite(ourTime) && assetTime > ourTime
  return { asset, update: newer, remoteSha }
}
