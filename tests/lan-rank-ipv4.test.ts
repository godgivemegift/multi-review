import assert from 'node:assert/strict'
import { rankIpv4 } from '../server/utils/lanState'

// 多网卡时挑最可能可达的 LAN 地址排第一(QR/分享链接用它)。

// 1) Wi-Fi + VPN(utun) + Docker 网桥：应选物理 en0 的 192.168 地址
assert.equal(
  rankIpv4([
    { name: 'utun3', address: '10.2.0.5' }, // VPN
    { name: 'en0', address: '192.168.1.44' }, // Wi-Fi
    { name: 'bridge100', address: '172.17.0.1' }, // Docker 网桥
  ])[0],
  '192.168.1.44',
)

// 2) 物理网卡用 10.x(有些办公网)，VPN 也在 10.x：物理网卡优先于 VPN
assert.equal(
  rankIpv4([
    { name: 'utun0', address: '10.8.0.2' }, // VPN
    { name: 'en1', address: '10.0.0.23' }, // 物理
  ])[0],
  '10.0.0.23',
)

// 3) link-local(169.254)永远垫底
{
  const r = rankIpv4([
    { name: 'en5', address: '169.254.10.10' },
    { name: 'en0', address: '192.168.0.7' },
  ])
  assert.equal(r[0], '192.168.0.7')
  assert.equal(r[r.length - 1], '169.254.10.10')
}

// 4) 单网卡：原样返回
assert.deepEqual(rankIpv4([{ name: 'en0', address: '192.168.1.2' }]), ['192.168.1.2'])

// 5) 空输入：空数组
assert.deepEqual(rankIpv4([]), [])

// 6) systemd 名(eno1)必须排在 libvirt 网桥(virbr0)前 —— 之前的正则漏了 eno1
assert.equal(
  rankIpv4([
    { name: 'virbr0', address: '192.168.122.1' }, // libvirt 默认桥
    { name: 'eno1', address: '10.0.0.50' }, // 物理网卡(systemd 命名)
  ])[0],
  '10.0.0.50',
)

// 7) Windows 友好名:真 "Wi-Fi" 排在 VirtualBox host-only 适配器前
assert.equal(
  rankIpv4([
    { name: 'VirtualBox Host-Only Ethernet Adapter', address: '192.168.56.1' },
    { name: 'Wi-Fi', address: '192.168.1.20' },
  ])[0],
  '192.168.1.20',
)

// 8) Docker 默认网桥(172.17)排在真网卡后
assert.equal(
  rankIpv4([
    { name: 'docker0', address: '172.17.0.1' },
    { name: 'ens160', address: '10.1.2.3' },
  ])[0],
  '10.1.2.3',
)

console.log('lan-rank-ipv4: ok')
