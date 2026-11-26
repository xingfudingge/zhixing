/**
 * 知行 WebDAV 目录布局与“目录清单推导状态”。
 *
 *   {root}/spaces/{spaceId}/ops/{deviceId}/{seq}-{opId}.ndjson
 *   {root}/spaces/{spaceId}/snapshots/{coveredSeq}-{deviceId}-{uuid}.json.gz
 *   {root}/spaces/{spaceId}/snapshots/{...}.json.gz.sha256
 *   {root}/spaces/{spaceId}/assets/{sha256}                 （小文件）
 *   {root}/spaces/{spaceId}/assets/.parts/{sha256}/{n}      （大文件分片）
 *   {root}/spaces/{spaceId}/assets/.parts/{sha256}/complete.json
 *
 * 没有可变 manifest，也没有全局游标：状态由文件名的 seq 推导。
 */

import {
  assertDeviceId,
  assertSpaceId,
  baseName,
  joinPath,
  parseSeq,
} from './paths.ts';
import type {
  DeviceOps,
  RemoteOpFile,
  RemoteState,
  SnapshotRef,
} from './types.ts';

export type SpaceLayout = {
  root: string;
  spaceId: string;
  spacePath: string;
  opsPath: string;
  snapshotsPath: string;
  assetsPath: string;
  partsPath: string;
  devicePath(deviceId: string): string;
  opPath(deviceId: string, seq: number, opId: string): string;
  snapshotPath(name: string): string;
  assetPath(sha256: string): string;
  assetPartPath(sha256: string, index: number): string;
  assetManifestPath(sha256: string): string;
};

export function createSpaceLayout(
  root: string,
  spaceIdRaw: string,
): SpaceLayout {
  const spaceId = assertSpaceId(spaceIdRaw);
  const spacePath = joinPath(root, 'spaces', spaceId);
  const opsPath = joinPath(spacePath, 'ops');
  const snapshotsPath = joinPath(spacePath, 'snapshots');
  const assetsPath = joinPath(spacePath, 'assets');
  const partsPath = joinPath(assetsPath, '.parts');

  return {
    root,
    spaceId,
    spacePath,
    opsPath,
    snapshotsPath,
    assetsPath,
    partsPath,
    devicePath(deviceId: string) {
      return joinPath(opsPath, assertDeviceId(deviceId));
    },
    opPath(deviceId: string, seq: number, opId: string) {
      if (!Number.isSafeInteger(seq) || seq < 1) {
        throw new Error(`非法 seq: ${seq}`);
      }
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(opId)) {
        throw new Error('op_id 含非法字符');
      }
      return joinPath(opsPath, assertDeviceId(deviceId), `${String(seq).padStart(12, '0')}-${opId}.ndjson`);
    },
    snapshotPath(name: string) {
      assertSnapshotName(name);
      return joinPath(snapshotsPath, name);
    },
    assetPath(sha256: string) {
      assertSha256(sha256);
      return joinPath(assetsPath, sha256);
    },
    assetPartPath(sha256: string, index: number) {
      assertSha256(sha256);
      if (!Number.isSafeInteger(index) || index < 0) {
        throw new Error(`非法分片序号: ${index}`);
      }
      return joinPath(partsPath, sha256, String(index).padStart(4, '0'));
    },
    assetManifestPath(sha256: string) {
      assertSha256(sha256);
      return joinPath(partsPath, sha256, 'complete.json');
    },
  };
}

export function assertSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error('sha256 必须是 64 位小写十六进制');
  }
}

export function parseDeviceIdEntry(name: string, isDirectory: boolean): string | null {
  if (!isDirectory) return null;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) return null;
  return name;
}

export function parseOpFileName(name: string): { seq: number; opId: string } | null {
  const match = /^(\d{12})-([A-Za-z0-9_-]{8,128})\.ndjson$/.exec(name);
  if (!match) return null;
  const seq = parseSeq(match[1]);
  if (seq === null || seq < 1) return null;
  return { seq, opId: match[2] };
}

export function parseSnapshotName(name: string): {
  coveredSeq: number;
  deviceId: string;
  uuid: string;
} | null {
  const match =
    /^(\d{12})-([A-Za-z0-9_-]{1,128})-([A-Za-z0-9_-]{8,128})\.json\.gz$/.exec(
      name,
    );
  if (!match) return null;
  const coveredSeq = parseSeq(match[1]);
  if (coveredSeq === null) return null;
  return { coveredSeq, deviceId: match[2], uuid: match[3] };
}

export function assertSnapshotName(name: string): void {
  if (!parseSnapshotName(name)) {
    throw new Error(`非法快照文件名: ${name}`);
  }
}

/** 从一个设备目录的 PROPFIND 清单推导 op 文件与最大 seq。 */
export function deriveDeviceOps(
  deviceId: string,
  entries: { path: string; name: string; isDirectory: boolean }[],
): DeviceOps {
  const files: RemoteOpFile[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const parsed = parseOpFileName(entry.name || baseName(entry.path));
    if (!parsed) continue;
    files.push({
      ...parsed,
      name: entry.name || baseName(entry.path),
      path: entry.path,
    });
  }
  files.sort((a, b) => (a.seq === b.seq ? a.opId.localeCompare(b.opId) : a.seq - b.seq));
  const maxSeq = files.reduce((max, file) => Math.max(max, file.seq), 0);
  return { deviceId, files, maxSeq };
}

/** 从 ops 根目录的 PROPFIND 清单取设备目录名。 */
export function deriveDeviceIds(
  entries: { name: string; isDirectory: boolean }[],
): string[] {
  const ids: string[] = [];
  for (const entry of entries) {
    const id = parseDeviceIdEntry(entry.name, entry.isDirectory);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.sort();
}

export function deriveSnapshotRefs(
  entries: { path: string; name: string; isDirectory: boolean }[],
): SnapshotRef[] {
  const refs: SnapshotRef[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const name = entry.name || baseName(entry.path);
    const parsed = parseSnapshotName(name);
    if (!parsed) continue;
    const shaPath = `${entry.path}.sha256`;
    refs.push({
      name,
      path: entry.path,
      sha256Path: shaPath,
      coveredSeq: parsed.coveredSeq,
      deviceId: parsed.deviceId,
    });
  }
  refs.sort((a, b) => {
    if (a.coveredSeq !== b.coveredSeq) return b.coveredSeq - a.coveredSeq;
    return a.name.localeCompare(b.name);
  });
  return refs;
}

export function deriveRemoteState(
  spaceId: string,
  devices: DeviceOps[],
  snapshots: SnapshotRef[],
): RemoteState {
  const maxSeqByDevice: Record<string, number> = {};
  for (const device of devices) {
    maxSeqByDevice[device.deviceId] = device.maxSeq;
  }
  return {
    spaceId: assertSpaceId(spaceId),
    devices,
    snapshots,
    maxSeqByDevice,
  };
}
