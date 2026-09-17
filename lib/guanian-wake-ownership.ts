import { loadInstalledCustomApps, readCustomAppCollection } from './custom-app-storage';

/** 挂念交给 VPS 后，宿主不再发送或重挂该 APP 的旧定时预约。 */
export function isGuanianServerWake(schedule: { id: string }): boolean {
  return loadInstalledCustomApps().some(app => app.manifest.id === 'gua.nian'
    && schedule.id.startsWith(`timed_wake_capp_${app.id}_`)
    && readCustomAppCollection(app.id, 'settings')[0]?.serverBrain === true);
}
