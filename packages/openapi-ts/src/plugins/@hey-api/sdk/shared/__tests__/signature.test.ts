import { describe, expect, it } from 'vitest';

import { getSignatureParameters } from '../signature';

const createOperation = (requestBodyRequired: boolean): any => ({
  body: {
    required: requestBodyRequired,
    schema: {
      properties: {
        contact_list: { type: 'string' },
        owner: { type: 'string' },
      },
      required: ['owner'],
      type: 'object',
    },
  },
});

describe('getSignatureParameters', () => {
  it('marks required body properties as required when request body is required', () => {
    const signature = getSignatureParameters({
      operation: createOperation(true),
      plugin: {} as any,
    });

    expect(signature?.parameters.owner?.isRequired).toBe(true);
    expect(signature?.parameters.contact_list?.isRequired).toBe(false);
  });

  it('keeps body properties optional when request body is optional', () => {
    const signature = getSignatureParameters({
      operation: createOperation(false),
      plugin: {} as any,
    });

    expect(signature?.parameters.owner?.isRequired).toBe(false);
    expect(signature?.parameters.contact_list?.isRequired).toBe(false);
  });
});
