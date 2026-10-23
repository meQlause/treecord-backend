import express, { type Express } from 'express';

/** Builds the Express app; middleware order is docs/BE/be-architecture.md §5. */
export const createApp = (): Express => express();
