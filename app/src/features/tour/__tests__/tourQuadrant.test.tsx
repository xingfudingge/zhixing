import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { TodayPage } from '../../../pages/Today/TodayPage';
import {
  createFakeTaskSource,
  TEST_TODAY,
} from '../../tasks/__tests__/fakeTaskSource';
import { TaskWorkspace } from '../../tasks/TaskWorkspace';

describe('导览「先看四象限」深链', () => {
  it('/today?view=quadrant 切到四象限，并把偏好写回设备设置', async () => {
    const source = createFakeTaskSource();
    render(
      <MemoryRouter initialEntries={['/today?view=quadrant']}>
        <TaskWorkspace source={source} today={TEST_TODAY}>
          <TodayPage />
        </TaskWorkspace>
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole('region', { name: '四象限：重要且紧急' }),
    ).toBeInTheDocument();

    await waitFor(() => {
      const stored = source
        .snapshot()
        .settings.find((setting) => setting.key === 'tasks.todayView');
      expect(stored?.value).toBe('quadrant');
    });
  });
});
