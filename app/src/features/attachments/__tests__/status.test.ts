import { describe, expect, it } from 'vitest';

import {
  describeAttachmentStatus,
  normalizeStateForMode,
  type AttachmentState,
} from '../types';

function state(status: AttachmentState['status']): AttachmentState {
  return {
    attachmentId: 'att_1',
    status,
    localBlobKey: 'attachments/hash',
    remoteId: null,
    uploadedPartIndexes: [],
    lastError: null,
    downloadedAt: null,
    updatedAt: '2026-10-29T00:00:00.000Z',
  };
}

describe('附件展示状态：按同步模式分流', () => {
  it('local 模式有本机副本时显示“本机已保存”，不显示“待上传/待同步”', () => {
    const display = describeAttachmentStatus({
      status: 'pending',
      hasLocal: true,
      mode: 'local',
      serviceAvailable: false,
    });
    expect(display.state).toBe('local_only');
    expect(display.label).toBe('本机已保存');
    expect(display.label).not.toMatch(/待上传|待同步/);
    expect(display.hint).toContain('不会上传');
  });

  it('local 模式本机哈希异常显示“本机文件异常”，仍不伪造同步状态', () => {
    const display = describeAttachmentStatus({
      status: 'failed',
      hasLocal: true,
      mode: 'local',
      serviceAvailable: false,
      lastError: '本机文件哈希不一致',
    });
    expect(display.state).toBe('local_error');
    expect(display.label).toBe('本机文件异常');
    expect(display.tone).toBe('danger');
  });

  it('backend 模式本机有副本但未上传时显示“本机已保存 · 未同步”', () => {
    const display = describeAttachmentStatus({
      status: 'local',
      hasLocal: true,
      mode: 'backend',
      serviceAvailable: true,
    });
    expect(display.state).toBe('local_saved');
    expect(display.label).toBe('本机已保存 · 未同步');
  });

  it('只有真正进入队列（pending/uploading）才显示“待同步/同步中”', () => {
    const pending = describeAttachmentStatus({
      status: 'pending',
      hasLocal: true,
      mode: 'backend',
      serviceAvailable: true,
    });
    expect(pending.state).toBe('pending_sync');
    expect(pending.label).toBe('待同步');

    const uploading = describeAttachmentStatus({
      status: 'uploading',
      hasLocal: true,
      mode: 'webdav',
      serviceAvailable: true,
    });
    expect(uploading.state).toBe('syncing');
    expect(uploading.label).toBe('同步中');
  });

  it('同步服务不可用时保留本机副本并明确说明', () => {
    const display = describeAttachmentStatus({
      status: 'local',
      hasLocal: true,
      mode: 'backend',
      serviceAvailable: false,
    });
    expect(display.state).toBe('service_unavailable');
    expect(display.label).toBe('服务不可用 · 本机已保存');
    expect(display.hint).toContain('仍保存在本机');
  });

  it('本机缺失时区分“远端可用”和“双方都缺失”', () => {
    const remote = describeAttachmentStatus({
      status: 'remote',
      hasLocal: false,
      mode: 'backend',
      serviceAvailable: true,
      remoteId: 'srv_1',
    });
    expect(remote.state).toBe('remote_only');
    expect(remote.label).toBe('远端可用 · 本机缺失');

    const missing = describeAttachmentStatus({
      status: 'missing',
      hasLocal: false,
      mode: 'local',
      serviceAvailable: false,
    });
    expect(missing.state).toBe('missing');
    expect(missing.label).toBe('文件缺失');
  });

  it('下载失败且本机无副本时是“下载失败 · 本机缺失”，不是“同步失败”', () => {
    const display = describeAttachmentStatus({
      status: 'failed',
      hasLocal: false,
      mode: 'backend',
      serviceAvailable: true,
      remoteId: 'srv_1',
      lastError: '模拟断网',
    });
    expect(display.state).toBe('download_failed');
    expect(display.label).toBe('下载失败 · 本机缺失');
  });

  it('上传失败但本机副本仍在时显示“同步失败 · 本机保留”', () => {
    const display = describeAttachmentStatus({
      status: 'failed',
      hasLocal: true,
      mode: 'backend',
      serviceAvailable: true,
      remoteId: 'srv_1',
      lastError: '模拟断网',
    });
    expect(display.state).toBe('sync_failed');
    expect(display.label).toBe('同步失败 · 本机保留');
  });
});

describe('旧状态归一化：不丢附件', () => {
  it('local 模式 pending + 有 Blob → local', () => {
    const next = normalizeStateForMode(state('pending'), 'local', true);
    expect(next.status).toBe('local');
    expect(next.lastError).toBeNull();
  });

  it('local 模式 pending + 无 Blob → missing，保留 localBlobKey 与 remoteId', () => {
    const source = {
      ...state('pending'),
      localBlobKey: 'attachments/old-hash',
      remoteId: 'srv_old',
    };
    const next = normalizeStateForMode(source, 'local', false);
    expect(next.status).toBe('missing');
    expect(next.localBlobKey).toBe('attachments/old-hash');
    expect(next.remoteId).toBe('srv_old');
  });

  it('backend 模式 pending 保持 pending（不把队列状态吞掉）', () => {
    expect(normalizeStateForMode(state('pending'), 'backend', true).status).toBe(
      'pending',
    );
  });
});
