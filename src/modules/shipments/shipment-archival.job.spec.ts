import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { envValidationSchema } from '../../config/env.validation';
import {
  ARCHIVAL_CRON_JOB_NAME,
  DEFAULT_ARCHIVAL_CRON,
  ShipmentArchivalJob,
} from './shipment-archival.job';

describe('ShipmentArchivalJob scheduling', () => {
  let registry: SchedulerRegistry;

  const createJob = (env: Record<string, string>) =>
    new ShipmentArchivalJob(
      {} as PrismaService,
      {} as RedisService,
      { get: (key: string, fallback?: unknown) => env[key] ?? fallback } as ConfigService,
      registry,
    );

  beforeEach(() => {
    registry = new SchedulerRegistry();
  });

  afterEach(() => {
    registry.getCronJobs().forEach((job) => job.stop());
  });

  it('registers with the default schedule when SHIPMENT_ARCHIVAL_CRON is unset', () => {
    createJob({}).onModuleInit();

    const job: CronJob = registry.getCronJob(ARCHIVAL_CRON_JOB_NAME);
    expect(job.cronTime.source).toBe(DEFAULT_ARCHIVAL_CRON);
  });

  it('honours SHIPMENT_ARCHIVAL_CRON', () => {
    createJob({ SHIPMENT_ARCHIVAL_CRON: '*/15 * * * *' }).onModuleInit();

    const job: CronJob = registry.getCronJob(ARCHIVAL_CRON_JOB_NAME);
    expect(job.cronTime.source).toBe('*/15 * * * *');
  });
});

describe('SHIPMENT_ARCHIVAL_CRON env validation', () => {
  const baseEnv = {
    JWT_SECRET: 'secret',
    DATABASE_URL: 'postgresql://localhost/db',
  };

  it('defaults to 0 3 * * *', () => {
    const { value } = envValidationSchema.validate(baseEnv, { allowUnknown: true });
    expect(value.SHIPMENT_ARCHIVAL_CRON).toBe(DEFAULT_ARCHIVAL_CRON);
  });

  it('accepts a valid cron expression', () => {
    const { error } = envValidationSchema.extract('SHIPMENT_ARCHIVAL_CRON').validate('30 2 * * 1');
    expect(error).toBeUndefined();
  });

  it('rejects an invalid cron expression', () => {
    const { error } = envValidationSchema.extract('SHIPMENT_ARCHIVAL_CRON').validate('not a cron');
    expect(error?.message).toMatch(/valid cron expression/);
  });
});
