// app/services/scheduler.server.ts
import { CronJob } from 'cron';
import { sendFollowUpEmails } from './email.server';

export const createEmailFollowUpJob = () => new CronJob(
  '0 0 * * *', // Run at midnight every day
  async () => {
    try {
      const results = await sendFollowUpEmails();
      console.log('Follow-up email results:', results);
    } catch (error) {
      console.error('Error in follow-up email job:', error);
    }
  },
  null,
  false,
  'UTC'
);