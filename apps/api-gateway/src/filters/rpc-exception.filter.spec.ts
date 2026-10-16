import { HttpException, HttpStatus } from '@nestjs/common';
import { AllExceptionsFilter } from './rpc-exception.filter';

const run = (exception: unknown) => {
  const json = jest.fn();
  const response: any = { status: jest.fn().mockReturnThis(), json };
  const host: any = { switchToHttp: () => ({ getResponse: () => response }) };
  new AllExceptionsFilter().catch(exception, host);
  return { status: response.status.mock.calls[0][0], body: json.mock.calls[0][0] };
};

describe('AllExceptionsFilter', () => {
  const previous = process.env.NODE_ENV;
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
  });
  afterAll(() => {
    process.env.NODE_ENV = previous;
  });

  it('shows the maintenance message that crossed the microservice boundary', () => {
    // How an RpcException payload arrives once it has crossed the TCP boundary.
    const { status, body } = run({
      statusCode: 503,
      message: 'We are currently under maintenance. Sign-in is paused.',
      error: 'Service Unavailable',
    });
    expect(status).toBe(503);
    expect(body.message).toBe('We are currently under maintenance. Sign-in is paused.');
  });

  it('keeps an HttpException 503 message', () => {
    const { body } = run(new HttpException('Under maintenance', HttpStatus.SERVICE_UNAVAILABLE));
    expect(body.message).toBe('Under maintenance');
  });

  it('still hides the details of an unexpected server fault in production', () => {
    const { status, body } = run(new Error('relation "users" does not exist'));
    expect(status).toBe(500);
    expect(body.message).toBe('An unexpected error occurred. Please try again later.');
  });
});
