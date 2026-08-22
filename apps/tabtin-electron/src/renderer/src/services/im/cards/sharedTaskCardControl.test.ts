import { describe, expect, it } from 'vitest';
import {
  projectCollaborationCta,
  projectContinuationCta,
  resolveCollaborationAction,
  resolveSharedTaskRole,
  resolveContinuationAction,
  transitionCollaboration,
  transitionContinuation,
} from './sharedTaskCardControl';

describe('shared task card control', () => {
  it('waits for the recipient after delivery, then activates after joining', () => {
    expect(
      transitionCollaboration('sending', 'deliveryConfirmedCollaborate'),
    ).toEqual({
      accepted: true,
      phase: 'awaitingJoin',
    });
    expect(resolveCollaborationAction('awaitingJoin', 'recipient')).toBe(
      'joinCollaboration',
    );
    expect(
      transitionCollaboration('awaitingJoin', 'joinStarted'),
    ).toEqual({ accepted: true, phase: 'joining' });
    expect(
      transitionCollaboration('joining', 'joinSucceededCollaborate'),
    ).toEqual({ accepted: true, phase: 'activeCollaborate' });
  });

  it.each([
    ['sending', 'deliveryConfirmedView', 'awaitingJoin'],
    ['sending', 'deliveryTimedOut', 'deliveryUnconfirmed'],
    [
      'deliveryUnconfirmed',
      'deliveryConfirmedCollaborate',
      'awaitingJoin',
    ],
    ['activeView', 'accessSetCollaborate', 'activeCollaborate'],
    ['activeCollaborate', 'accessSetView', 'activeView'],
    ['activeCollaborate', 'ownerWentOffline', 'ownerOffline'],
    ['ownerOffline', 'ownerCameOnline', 'activeCollaborate'],
    ['activeView', 'stopConfirmed', 'stopped'],
    ['ownerOffline', 'stopConfirmed', 'stopped'],
    ['stopped', 'restoreConfirmedView', 'activeView'],
    ['stopped', 'restoreConfirmedCollaborate', 'activeCollaborate'],
    ['activeView', 'eligibilityLost', 'ineligible'],
    ['activeView', 'detailFailed', 'detailError'],
  ] as const)('moves collaboration from %s on %s', (phase, event, expected) => {
    expect(transitionCollaboration(phase, event)).toEqual({
      accepted: true,
      phase: expected,
    });
  });

  it('only allows a safe retry when collaboration details cannot be loaded', () => {
    expect(resolveCollaborationAction('detailError', 'owner')).toBe(
      'retryLoad',
    );
    expect(resolveCollaborationAction('detailError', 'recipient')).toBe(
      'retryLoad',
    );
  });

  it.each([
    ['detailsReloadedOwnerOffline', 'ownerOffline'],
    ['detailsReloadedDeliveryUnconfirmed', 'deliveryUnconfirmed'],
    ['detailsReloadedStopped', 'stopped'],
  ] as const)(
    'returns to authoritative collaboration state %s after retry',
    (event, phase) => {
      expect(transitionCollaboration('detailError', event)).toEqual({
        accepted: true,
        phase,
      });
    },
  );

  it('keeps the original task available to its owner after recipient access ends', () => {
    expect(resolveCollaborationAction('stopped', 'owner')).toBe(
      'openOriginalTask',
    );
    expect(resolveCollaborationAction('stopped', 'recipient')).toBe(
      'inspectStatus',
    );
    expect(resolveCollaborationAction('ineligible', 'recipient')).toBe(
      'inspectReason',
    );
  });

  it.each([
    ['sending', 'owner', null],
    ['sending', 'recipient', null],
    ['awaitingJoin', 'owner', 'openOriginalTask'],
    ['awaitingJoin', 'recipient', 'joinCollaboration'],
    ['joining', 'recipient', null],
    ['activeView', 'owner', 'openOriginalTask'],
    ['activeView', 'recipient', 'openCollaboration'],
    ['activeCollaborate', 'owner', 'openOriginalTask'],
    ['activeCollaborate', 'recipient', 'openCollaboration'],
    ['ownerOffline', 'owner', 'openOriginalTask'],
    ['ownerOffline', 'recipient', 'openCollaborationHistory'],
    ['deliveryUnconfirmed', 'owner', 'retryDelivery'],
    ['deliveryUnconfirmed', 'recipient', null],
    ['stopped', 'owner', 'openOriginalTask'],
    ['stopped', 'recipient', 'inspectStatus'],
    ['ineligible', 'owner', 'openOriginalTask'],
    ['ineligible', 'recipient', 'inspectReason'],
    ['detailError', 'owner', 'retryLoad'],
    ['detailError', 'recipient', 'retryLoad'],
    ['activeCollaborate', 'observer', null],
    ['detailError', 'observer', null],
  ] as const)('projects collaboration %s for %s', (phase, role, action) => {
    expect(resolveCollaborationAction(phase, role)).toBe(action);
  });

  it('prevents duplicate continuation creation while a task is being created', () => {
    expect(transitionContinuation('pending', 'createStarted')).toEqual({
      accepted: true,
      phase: 'creating',
    });
    expect(transitionContinuation('creating', 'createStarted')).toEqual({
      accepted: false,
      phase: 'creating',
    });
  });

  it.each([
    ['sending', 'deliveryConfirmed', 'pending'],
    ['pending', 'contextTruncated', 'truncated'],
    ['pending', 'resourcesPartiallyUnavailable', 'partial'],
    ['pending', 'contextEmpty', 'empty'],
    ['truncated', 'createStarted', 'creating'],
    ['partial', 'createStarted', 'creating'],
    ['creating', 'createSucceeded', 'created'],
    ['creating', 'createFailed', 'createFailed'],
    ['createFailed', 'retryCreateStarted', 'creating'],
    ['pending', 'eligibilityLost', 'invalid'],
    ['pending', 'detailFailed', 'detailError'],
  ] as const)('moves continuation from %s on %s', (phase, event, expected) => {
    expect(transitionContinuation(phase, event)).toEqual({
      accepted: true,
      phase: expected,
    });
  });

  it('keeps continuation ownership with the recipient', () => {
    expect(resolveContinuationAction('pending', 'owner')).toBeNull();
    expect(resolveContinuationAction('created', 'owner')).toBeNull();
    expect(resolveContinuationAction('pending', 'recipient')).toBe(
      'createContinuationTask',
    );
    expect(resolveContinuationAction('created', 'recipient')).toBe(
      'openContinuationTask',
    );
  });

  it('returns to the latest authoritative continuation state after retry', () => {
    expect(
      transitionContinuation('detailError', 'detailsReloadedCreated'),
    ).toEqual({ accepted: true, phase: 'created' });
  });

  it.each([
    ['sending', 'owner', null],
    ['sending', 'recipient', null],
    ['pending', 'owner', null],
    ['pending', 'recipient', 'createContinuationTask'],
    ['truncated', 'owner', null],
    ['truncated', 'recipient', 'createContinuationTask'],
    ['partial', 'owner', null],
    ['partial', 'recipient', 'createContinuationTask'],
    ['empty', 'owner', null],
    ['empty', 'recipient', null],
    ['creating', 'owner', null],
    ['creating', 'recipient', null],
    ['created', 'owner', null],
    ['created', 'recipient', 'openContinuationTask'],
    ['createFailed', 'owner', null],
    ['createFailed', 'recipient', 'retryContinuationCreation'],
    ['invalid', 'owner', null],
    ['invalid', 'recipient', 'inspectReason'],
    ['detailError', 'owner', 'retryLoad'],
    ['detailError', 'recipient', 'retryLoad'],
    ['pending', 'observer', null],
    ['detailError', 'observer', null],
  ] as const)('projects continuation %s for %s', (phase, role, action) => {
    expect(resolveContinuationAction(phase, role)).toBe(action);
  });

  it('fails closed when an event is invalid for the current phase', () => {
    expect(transitionCollaboration('stopped', 'ownerCameOnline')).toEqual({
      accepted: false,
      phase: 'stopped',
    });
    expect(transitionContinuation('created', 'createStarted')).toEqual({
      accepted: false,
      phase: 'created',
    });
  });

  it('derives role from the card parties and fails closed for observers', () => {
    expect(resolveSharedTaskRole('sender-1', 'sender-1', 'recipient-1')).toBe(
      'owner',
    );
    expect(
      resolveSharedTaskRole('recipient-1', 'sender-1', 'recipient-1'),
    ).toBe('recipient');
    expect(resolveSharedTaskRole('other-1', 'sender-1', 'recipient-1')).toBe(
      'observer',
    );
  });

  it('projects disabled and loading collaboration CTAs separately from commands', () => {
    expect(projectCollaborationCta('sending', 'owner')).toEqual({
      kind: 'waitingForDelivery',
      command: null,
      disabled: true,
      loading: true,
    });
    expect(projectCollaborationCta('sending', 'recipient')).toBeNull();
    expect(projectCollaborationCta('awaitingJoin', 'recipient')).toMatchObject({
      kind: 'joinCollaboration',
      command: 'joinCollaboration',
      disabled: false,
    });
    expect(projectCollaborationCta('joining', 'recipient')).toEqual({
      kind: 'joining',
      command: null,
      disabled: true,
      loading: true,
    });
    expect(projectCollaborationCta('deliveryUnconfirmed', 'recipient')).toEqual(
      {
        kind: 'waitingForDelivery',
        command: null,
        disabled: true,
        loading: false,
      },
    );
  });

  it('projects continuation operation CTAs without exposing duplicate commands', () => {
    expect(projectContinuationCta('sending', 'owner')).toEqual({
      kind: 'waitingForDelivery',
      command: null,
      disabled: true,
      loading: true,
    });
    expect(projectContinuationCta('sending', 'recipient')).toBeNull();
    expect(projectContinuationCta('empty', 'recipient')).toMatchObject({
      kind: 'creationUnavailable',
      command: null,
      disabled: true,
    });
    expect(projectContinuationCta('creating', 'recipient')).toEqual({
      kind: 'creating',
      command: null,
      disabled: true,
      loading: true,
    });
    expect(projectContinuationCta('pending', 'recipient')).toMatchObject({
      kind: 'createContinuationTask',
      command: 'createContinuationTask',
      disabled: false,
    });
  });
});
