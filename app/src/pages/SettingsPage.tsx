import { Navigate, useParams } from 'react-router-dom';

import { settingsGroupOf } from '../app/shell/navigation';
import { SettingsWorkspace } from '../features/settings';

export function SettingsPage() {
  const { group } = useParams();
  const meta = settingsGroupOf(group);

  if (!meta) {
    return <Navigate to="/settings/appearance" replace />;
  }

  return <SettingsWorkspace group={meta.id} />;
}
