import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type PublicUser } from '../api.js';
import { useSession } from './session.js';

const user: PublicUser = { id: 'user-1', username: 'alice', role: 'admin' };

describe('session bootstrap', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useSession.setState({ user: undefined, checked: false, bootstrapError: null });
  });

  it('treats only a 401 response as an unauthenticated session', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(new ApiError(401, 'unauthorized', 'required'));

    await useSession.getState().bootstrap();

    expect(useSession.getState()).toMatchObject({
      user: null,
      checked: true,
      bootstrapError: null,
    });
  });

  it.each([
    new ApiError(503, 'internal_error', 'unavailable'),
    new TypeError('network failed'),
    new SyntaxError('invalid JSON'),
  ])('keeps %s out of the logged-out state', async (failure) => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(failure);

    await useSession.getState().bootstrap();

    expect(useSession.getState()).toMatchObject({
      user: undefined,
      checked: true,
      bootstrapError: 'Could not connect to Clawtide. Check the server and try again.',
    });
  });

  it('clears an earlier failure and restores the session on retry', async () => {
    vi.spyOn(api, 'get')
      .mockRejectedValueOnce(new TypeError('network failed'))
      .mockResolvedValueOnce({ user });

    await useSession.getState().bootstrap();
    await useSession.getState().bootstrap();

    expect(useSession.getState()).toMatchObject({ user, checked: true, bootstrapError: null });
  });
});
