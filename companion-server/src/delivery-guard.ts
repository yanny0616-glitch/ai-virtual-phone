import type { Store } from "./store.ts";
import type { GenerationLease } from "./generation-lease.ts";

export class DeliveryPaused extends Error {}

type DeliveryDeps = { store: Store; halted?: (characterId: string, wakeId: string) => boolean };

export function assertDeliveryActive(deps: DeliveryDeps, characterId: string, sessionId: string, wakeId: string): void {
  const c = deps.store.getCharacter(characterId);
  const timer = wakeId ? deps.store.getTimer(wakeId) : null;
  if (!c || !c.enabled || Number(c.settings.recheckEnabled) === 0) throw new DeliveryPaused("角色已停用，暂停交付");
  if (c.sessionId !== sessionId) throw new DeliveryPaused("会话已变更，暂停旧会话交付");
  if (deps.halted?.(characterId, wakeId) || timer?.status === "cancelled") throw new DeliveryPaused("停用或取消正在处理，暂停交付");
}

/** 每次外部副作用前调用；网络等待期间排队的停用/取消也必须可见。 */
export async function checkDelivery(
  deps: DeliveryDeps,
  characterId: string, sessionId: string, wakeId: string, lease: GenerationLease,
): Promise<void> {
  const active = () => assertDeliveryActive(deps, characterId, sessionId, wakeId);
  active();
  await lease.check();
  active();
}
