import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { DEFAULT_APP_SETTINGS } from '../../../data/repositories/settings';
import type { NoteEncryptionStatus } from '../../../data/db/types';
import type { SettingsWorkspaceValue } from '../useSettingsWorkspace';

const mocks = vi.hoisted(() => ({
  supported: true,
  status: null as unknown as NoteEncryptionStatus,
  getStatus: vi.fn(),
  enable: vi.fn(),
  unlock: vi.fn(),
  lock: vi.fn(),
  disable: vi.fn(),
  change: vi.fn(),
  exportEnvelope: vi.fn(),
  importEnvelope: vi.fn(),
}));

vi.mock('../noteEncryption', () => ({
  NOTE_ENCRYPTION_CHANGED_EVENT: 'zhixing:note-encryption-changed',
  noteEncryptionSupported: () => mocks.supported,
  getNoteEncryptionStatus: mocks.getStatus,
  enableNoteEncryption: mocks.enable,
  unlockNoteEncryption: mocks.unlock,
  lockNoteEncryption: mocks.lock,
  disableNoteEncryption: mocks.disable,
  changeNoteEncryptionPassphrase: mocks.change,
  exportNoteEncryptionEnvelope: mocks.exportEnvelope,
  importNoteEncryptionEnvelope: mocks.importEnvelope,
  formatNoteEncryptionError: (reason: unknown) =>
    reason instanceof Error ? reason.message : String(reason),
}));

import { monitor } from '../../export/monitoring';
import { PrivacyGroup } from '../groups/PrivacyGroup';

function status(patch: Partial<NoteEncryptionStatus> = {}): NoteEncryptionStatus {
  return {
    supported: true,
    configured: false,
    enabled: false,
    locked: false,
    keyMissing: false,
    storage: 'keychain',
    algorithm: 'Argon2id+AEAD',
    keyId: null,
    encryptedNotes: 0,
    totalNotes: 8,
    plaintextNotes: 8,
    noteAttachments: 0,
    pendingEncryption: false,
    error: null,
    ...patch,
  };
}

function makeWorkspace() {
  const updatePrivacy = vi.fn(async () => DEFAULT_APP_SETTINGS);
  const workspace = {
    settings: {
      ...DEFAULT_APP_SETTINGS,
      privacy: { ...DEFAULT_APP_SETTINGS.privacy, diagnosticsEnabled: false },
    },
    sourceMode: 'sqlite',
    updatePrivacy,
  } as unknown as SettingsWorkspaceValue;
  return { workspace, updatePrivacy };
}

function renderGroup(workspace: SettingsWorkspaceValue) {
  return render(
    <MemoryRouter>
      <PrivacyGroup workspace={workspace} />
    </MemoryRouter>,
  );
}

describe('隐私与安全：加密笔记与诊断数据', () => {
  beforeEach(() => {
    mocks.supported = true;
    mocks.status = status();
    mocks.getStatus.mockReset().mockImplementation(async () => mocks.status);
    mocks.enable.mockReset();
    mocks.unlock.mockReset();
    mocks.lock.mockReset();
    mocks.disable.mockReset();
    mocks.change.mockReset();
    mocks.exportEnvelope.mockReset();
    mocks.importEnvelope.mockReset();
    monitor.setEnabled(false);
    monitor.reset();
  });

  it('诊断默认关闭；开启与清除写入持久化设置并清空本机缓冲', async () => {
    const { workspace, updatePrivacy } = makeWorkspace();
    const reset = vi.spyOn(monitor, 'reset');
    const user = userEvent.setup();
    renderGroup(workspace);

    const toggle = await screen.findByRole('switch', {
      name: '开启本机诊断记录',
    });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(
      screen.getByText(/不记录笔记\/任务正文、文件路径、账号、口令或密钥/),
    ).toBeInTheDocument();

    await user.click(toggle);
    expect(updatePrivacy).toHaveBeenCalledWith({ diagnosticsEnabled: true });

    await user.click(
      screen.getByRole('button', { name: '清除本机诊断数据' }),
    );
    expect(reset).toHaveBeenCalled();
  });

  it('未配置时设置口令并加密；锁定态显示解锁入口', async () => {
    const { workspace } = makeWorkspace();
    mocks.enable.mockResolvedValue({
      ...status({
        configured: true,
        enabled: true,
        encryptedNotes: 8,
        plaintextNotes: 0,
      }),
      transformed: { notes: 8, blocks: 12, todos: 3 },
      warning: null,
    });
    const user = userEvent.setup();
    renderGroup(workspace);

    await user.click(
      await screen.findByRole('button', {
        name: '设置口令并加密全部笔记',
      }),
    );
    fireEvent.change(screen.getByLabelText('口令'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.change(screen.getByLabelText('确认新口令'), {
      target: { value: 'correct horse battery' },
    });
    await user.click(screen.getByRole('button', { name: '加密全部笔记' }));

    await waitFor(() =>
      expect(mocks.enable).toHaveBeenCalledWith('correct horse battery'),
    );

    mocks.status = status({
      configured: true,
      enabled: true,
      locked: true,
      encryptedNotes: 8,
      plaintextNotes: 0,
      keyId: 'abcdef0123456789',
    });
    mocks.unlock.mockResolvedValue({ ...mocks.status, locked: false });
    window.dispatchEvent(new Event('zhixing:note-encryption-changed'));

    await user.click(await screen.findByRole('button', { name: '解锁' }));
    fireEvent.change(screen.getByLabelText('口令'), {
      target: { value: 'correct horse battery' },
    });
    await user.click(
      screen.getAllByRole('button', { name: '解锁' }).at(-1)!,
    );

    await waitFor(() =>
      expect(mocks.unlock).toHaveBeenCalledWith('correct horse battery'),
    );
  });

  it('浏览器预览明确显示仅桌面壳可用，不给假开关', async () => {
    mocks.supported = false;
    mocks.status = status({ supported: false });
    const { workspace } = makeWorkspace();
    renderGroup(workspace);

    expect(await screen.findByText('仅桌面壳')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '设置口令并加密全部笔记' }),
    ).not.toBeInTheDocument();
  });

  it('笔记附件未纳入加密边界时禁用开启按钮并给出原因', async () => {
    mocks.status = status({ noteAttachments: 2 });
    const { workspace } = makeWorkspace();
    renderGroup(workspace);

    expect(
      await screen.findByText(/有 2 个笔记附件未纳入加密边界/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '设置口令并加密全部笔记' }),
    ).toBeDisabled();
  });
});
