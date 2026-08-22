/**
 * 新共享任务卡的客户端控制投影。这些 phase 服务于交互与安全动作投影，
 * 不是服务端持久化字段；权威详情加载成功后应直接投影到最新 phase。
 */
export type SharedTaskRole = 'owner' | 'recipient' | 'observer';
export type CollaborationAction =
  | 'joinCollaboration'
  | 'openOriginalTask'
  | 'openCollaboration'
  | 'openCollaborationHistory'
  | 'inspectStatus'
  | 'inspectReason'
  | 'retryDelivery'
  | 'retryLoad';
export type ContinuationAction =
  | 'createContinuationTask'
  | 'openContinuationTask'
  | 'retryContinuationCreation'
  | 'inspectReason'
  | 'retryLoad';

export type CollaborationPhase =
  | 'sending'
  | 'awaitingJoin'
  | 'joining'
  | 'activeView'
  | 'activeCollaborate'
  | 'ownerOffline'
  | 'deliveryUnconfirmed'
  | 'stopped'
  | 'ineligible'
  | 'detailError';
export type CollaborationEvent =
  | 'deliveryConfirmedView'
  | 'deliveryConfirmedCollaborate'
  | 'deliveryTimedOut'
  | 'joinStarted'
  | 'joinSucceededView'
  | 'joinSucceededCollaborate'
  | 'joinFailed'
  | 'accessSetView'
  | 'accessSetCollaborate'
  | 'ownerWentOffline'
  | 'ownerCameOnline'
  | 'stopConfirmed'
  | 'restoreConfirmedView'
  | 'restoreConfirmedCollaborate'
  | 'eligibilityLost'
  | 'detailFailed'
  | 'detailsReloadedView'
  | 'detailsReloadedCollaborate'
  | 'detailsReloadedAwaitingJoin'
  | 'detailsReloadedOwnerOffline'
  | 'detailsReloadedDeliveryUnconfirmed'
  | 'detailsReloadedStopped'
  | 'detailsReloadedIneligible';
export type ContinuationPhase =
  | 'sending'
  | 'pending'
  | 'truncated'
  | 'partial'
  | 'empty'
  | 'creating'
  | 'created'
  | 'createFailed'
  | 'invalid'
  | 'detailError';
export type ContinuationEvent =
  | 'deliveryConfirmed'
  | 'contextTruncated'
  | 'resourcesPartiallyUnavailable'
  | 'contextEmpty'
  | 'createStarted'
  | 'createSucceeded'
  | 'createFailed'
  | 'retryCreateStarted'
  | 'eligibilityLost'
  | 'detailFailed'
  | 'detailsReloadedPending'
  | 'detailsReloadedTruncated'
  | 'detailsReloadedPartial'
  | 'detailsReloadedEmpty'
  | 'detailsReloadedCreating'
  | 'detailsReloadedCreated'
  | 'detailsReloadedCreateFailed'
  | 'detailsReloadedInvalid';

export interface SharedTaskCardTransition<Phase extends string> {
  accepted: boolean;
  phase: Phase;
}

type TransitionTable<Phase extends string, Event extends string> = Readonly<
  Record<Phase, Readonly<Partial<Record<Event, Phase>>>>
>;

const COLLABORATION_TRANSITIONS: TransitionTable<
  CollaborationPhase,
  CollaborationEvent
> = {
  sending: {
    deliveryConfirmedView: 'awaitingJoin',
    deliveryConfirmedCollaborate: 'awaitingJoin',
    deliveryTimedOut: 'deliveryUnconfirmed',
  },
  awaitingJoin: {
    joinStarted: 'joining',
    stopConfirmed: 'stopped',
    eligibilityLost: 'ineligible',
    detailFailed: 'detailError',
  },
  joining: {
    joinSucceededView: 'activeView',
    joinSucceededCollaborate: 'activeCollaborate',
    joinFailed: 'awaitingJoin',
    eligibilityLost: 'ineligible',
  },
  activeView: {
    accessSetCollaborate: 'activeCollaborate',
    stopConfirmed: 'stopped',
    eligibilityLost: 'ineligible',
    detailFailed: 'detailError',
  },
  activeCollaborate: {
    accessSetView: 'activeView',
    ownerWentOffline: 'ownerOffline',
    stopConfirmed: 'stopped',
    eligibilityLost: 'ineligible',
    detailFailed: 'detailError',
  },
  ownerOffline: {
    ownerCameOnline: 'activeCollaborate',
    stopConfirmed: 'stopped',
    eligibilityLost: 'ineligible',
    detailFailed: 'detailError',
  },
  deliveryUnconfirmed: {
    deliveryConfirmedView: 'awaitingJoin',
    deliveryConfirmedCollaborate: 'awaitingJoin',
    stopConfirmed: 'stopped',
    eligibilityLost: 'ineligible',
    detailFailed: 'detailError',
  },
  stopped: {
    restoreConfirmedView: 'activeView',
    restoreConfirmedCollaborate: 'activeCollaborate',
    eligibilityLost: 'ineligible',
    detailFailed: 'detailError',
  },
  ineligible: {},
  detailError: {
    detailsReloadedAwaitingJoin: 'awaitingJoin',
    detailsReloadedView: 'activeView',
    detailsReloadedCollaborate: 'activeCollaborate',
    detailsReloadedOwnerOffline: 'ownerOffline',
    detailsReloadedDeliveryUnconfirmed: 'deliveryUnconfirmed',
    detailsReloadedStopped: 'stopped',
    detailsReloadedIneligible: 'ineligible',
  },
};

const CONTINUATION_TRANSITIONS: TransitionTable<
  ContinuationPhase,
  ContinuationEvent
> = {
  sending: { deliveryConfirmed: 'pending' },
  pending: {
    contextTruncated: 'truncated',
    resourcesPartiallyUnavailable: 'partial',
    contextEmpty: 'empty',
    createStarted: 'creating',
    eligibilityLost: 'invalid',
    detailFailed: 'detailError',
  },
  truncated: {
    contextEmpty: 'empty',
    createStarted: 'creating',
    eligibilityLost: 'invalid',
    detailFailed: 'detailError',
  },
  partial: {
    contextEmpty: 'empty',
    createStarted: 'creating',
    eligibilityLost: 'invalid',
    detailFailed: 'detailError',
  },
  empty: {
    eligibilityLost: 'invalid',
    detailFailed: 'detailError',
  },
  creating: {
    createSucceeded: 'created',
    createFailed: 'createFailed',
    eligibilityLost: 'invalid',
    detailFailed: 'detailError',
  },
  created: { detailFailed: 'detailError' },
  createFailed: {
    retryCreateStarted: 'creating',
    eligibilityLost: 'invalid',
    detailFailed: 'detailError',
  },
  invalid: {},
  detailError: {
    detailsReloadedPending: 'pending',
    detailsReloadedTruncated: 'truncated',
    detailsReloadedPartial: 'partial',
    detailsReloadedEmpty: 'empty',
    detailsReloadedCreating: 'creating',
    detailsReloadedCreated: 'created',
    detailsReloadedCreateFailed: 'createFailed',
    detailsReloadedInvalid: 'invalid',
  },
};

function transition<Phase extends string, Event extends string>(
  phase: Phase,
  event: Event,
  table: TransitionTable<Phase, Event>,
): SharedTaskCardTransition<Phase> {
  const next = table[phase][event];
  return next ? { accepted: true, phase: next } : { accepted: false, phase };
}

export function transitionCollaboration(
  phase: CollaborationPhase,
  event: CollaborationEvent,
): SharedTaskCardTransition<CollaborationPhase> {
  return transition(phase, event, COLLABORATION_TRANSITIONS);
}

export function resolveSharedTaskRole(
  currentUserId: string | null | undefined,
  senderId: string,
  recipientId: string,
): SharedTaskRole {
  if (currentUserId === senderId) return 'owner';
  if (currentUserId === recipientId) return 'recipient';
  return 'observer';
}

export function resolveCollaborationAction(
  phase: CollaborationPhase,
  role: SharedTaskRole,
): CollaborationAction | null {
  if (role === 'observer') return null;
  if (phase === 'detailError') return 'retryLoad';
  if (phase === 'deliveryUnconfirmed')
    return role === 'owner' ? 'retryDelivery' : null;
  if (phase === 'stopped')
    return role === 'owner' ? 'openOriginalTask' : 'inspectStatus';
  if (phase === 'ineligible')
    return role === 'owner' ? 'openOriginalTask' : 'inspectReason';
  if (role === 'owner') {
    return phase === 'sending' ? null : 'openOriginalTask';
  }
  if (phase === 'awaitingJoin') return 'joinCollaboration';
  if (phase === 'activeView' || phase === 'activeCollaborate')
    return 'openCollaboration';
  if (phase === 'ownerOffline') return 'openCollaborationHistory';
  return null;
}

export function transitionContinuation(
  phase: ContinuationPhase,
  event: ContinuationEvent,
): SharedTaskCardTransition<ContinuationPhase> {
  return transition(phase, event, CONTINUATION_TRANSITIONS);
}

export function resolveContinuationAction(
  phase: ContinuationPhase,
  role: SharedTaskRole,
): ContinuationAction | null {
  if (role === 'observer') return null;
  if (phase === 'detailError') return 'retryLoad';
  if (role === 'owner') return null;
  if (phase === 'pending' || phase === 'truncated' || phase === 'partial') {
    return 'createContinuationTask';
  }
  if (phase === 'created') return 'openContinuationTask';
  if (phase === 'createFailed') return 'retryContinuationCreation';
  if (phase === 'invalid') return 'inspectReason';
  return null;
}

export type CollaborationPassiveCta = 'waitingForDelivery' | 'joining';
export type ContinuationPassiveCta =
  | 'waitingForDelivery'
  | 'creationUnavailable'
  | 'creating';

export interface SharedTaskCtaProjection<
  Kind extends string,
  Action extends string,
> {
  kind: Kind;
  command: Action | null;
  disabled: boolean;
  loading: boolean;
}

export function projectCollaborationCta(
  phase: CollaborationPhase,
  role: SharedTaskRole,
): SharedTaskCtaProjection<
  CollaborationAction | CollaborationPassiveCta,
  CollaborationAction
> | null {
  const command = resolveCollaborationAction(phase, role);
  if (command)
    return { kind: command, command, disabled: false, loading: false };
  if (role === 'observer') return null;
  if (phase === 'sending' && role === 'owner') {
    return {
      kind: 'waitingForDelivery',
      command: null,
      disabled: true,
      loading: true,
    };
  }
  if (phase === 'deliveryUnconfirmed' && role === 'recipient') {
    return {
      kind: 'waitingForDelivery',
      command: null,
      disabled: true,
      loading: false,
    };
  }
  if (phase === 'joining' && role === 'recipient') {
    return { kind: 'joining', command: null, disabled: true, loading: true };
  }
  return null;
}

export function projectContinuationCta(
  phase: ContinuationPhase,
  role: SharedTaskRole,
): SharedTaskCtaProjection<
  ContinuationAction | ContinuationPassiveCta,
  ContinuationAction
> | null {
  const command = resolveContinuationAction(phase, role);
  if (command)
    return { kind: command, command, disabled: false, loading: false };
  if (role === 'observer') return null;
  if (phase === 'sending' && role === 'owner') {
    return {
      kind: 'waitingForDelivery',
      command: null,
      disabled: true,
      loading: true,
    };
  }
  if (role === 'owner') return null;
  if (phase === 'empty') {
    return {
      kind: 'creationUnavailable',
      command: null,
      disabled: true,
      loading: false,
    };
  }
  if (phase === 'creating') {
    return { kind: 'creating', command: null, disabled: true, loading: true };
  }
  return null;
}
