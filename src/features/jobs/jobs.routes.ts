import { Router } from 'express';
import { z } from 'zod';
import { pathParam } from '../../shared/http/params.js';
import { toJobDto } from './jobs.mapper.js';
import type { createJobsService } from './jobs.service.js';

type JobsService = ReturnType<typeof createJobsService>;
type Caller = { id: string; role: string };

const jobId = z.uuid();

/** Private routes, mounted under /api/v1 behind authentication (jobs §2). */
export const jobsRouter = (jobs: JobsService): Router =>
  Router().get('/jobs/:id', async (req, res) => {
    const caller = res.locals['profile'] as Caller;
    const job = await jobs.jobFor(caller, pathParam(jobId, req.params.id));

    // polled while it changes (FR-027)
    res
      .set('Cache-Control', 'no-store')
      .json({ job: toJobDto(job, { withLastError: caller.role === 'operator' }) });
  });
