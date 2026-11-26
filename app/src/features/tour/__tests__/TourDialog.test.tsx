import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { TourDialog } from '../TourDialog';
import { TOUR_QUADRANT_PATH, TOUR_SHORTCUTS, TOUR_STEPS } from '../tourSteps';

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">
      {location.pathname}
      {location.search}
    </div>
  );
}

function renderTour() {
  const onClose = vi.fn();
  render(
    <MemoryRouter initialEntries={['/today']}>
      <TourDialog open onClose={onClose} />
      <Routes>
        <Route path="/today" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
  return { onClose };
}

describe('产品导览', () => {
  it('列出 7 个模块与快捷键，且不伪造数据操作', () => {
    renderTour();
    expect(screen.getByRole('dialog', { name: '产品导览' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(TOUR_STEPS.length);
    expect(screen.getByText('今天')).toBeInTheDocument();
    expect(screen.getByText('画板')).toBeInTheDocument();
    expect(screen.getByText('设置与状态胶囊')).toBeInTheDocument();

    for (const shortcut of TOUR_SHORTCUTS) {
      expect(screen.getByText(shortcut.label)).toBeInTheDocument();
    }
    expect(screen.getAllByText(/⌘K/).length).toBeGreaterThan(0);
  });

  it('「先看四象限」关闭导览并跳到目标深链', async () => {
    const user = userEvent.setup();
    const { onClose } = renderTour();

    await user.click(screen.getByRole('button', { name: '先看四象限' }));
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByTestId('location')).toHaveTextContent(
      TOUR_QUADRANT_PATH,
    );
  });
});
