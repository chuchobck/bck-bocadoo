import { Module } from '@nestjs/common';
import { FollowUpController, FollowUpService } from './follow-up';
import { OperationsController, OperationsService } from './operations';
import { SummaryController, SummaryService } from './summary';

@Module({
  controllers: [SummaryController, OperationsController, FollowUpController],
  providers: [SummaryService, OperationsService, FollowUpService],
})
export class ReportsModule {}
