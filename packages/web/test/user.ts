import base from '@testing-library/user-event';

/**
 * userEvent without the per-action macrotask delay (`delay: null`). Same call shape as the default
 * export (`userEvent.click(el)`, ...), but each call gets its own fresh instance like the direct
 * API does. This keeps long dialog flows fast under full-suite load.
 */
const fresh = () => base.setup({ delay: null });

const userEvent = {
  setup: (options: Parameters<typeof base.setup>[0] = {}) =>
    base.setup({ delay: null, ...options }),
  click: (...a: Parameters<ReturnType<typeof fresh>['click']>) => fresh().click(...a),
  clear: (...a: Parameters<ReturnType<typeof fresh>['clear']>) => fresh().clear(...a),
  type: (...a: Parameters<ReturnType<typeof fresh>['type']>) => fresh().type(...a),
  keyboard: (...a: Parameters<ReturnType<typeof fresh>['keyboard']>) => fresh().keyboard(...a),
  tab: (...a: Parameters<ReturnType<typeof fresh>['tab']>) => fresh().tab(...a),
};

export default userEvent;
