import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { AdminDashboardController } from "./admin-dashboard.controller";
import { AdminDashboardService } from "./admin-dashboard.service";
import { TokenRegistryModule } from "../../common/token-registry/token-registry.module";
import { FxModule } from "../../common/fx/fx.module";
import { AuditLogsModule } from "../audit-logs/audit-logs.module";

@Module({
  imports: [ScheduleModule, TokenRegistryModule, FxModule, AuditLogsModule],
  controllers: [AdminDashboardController],
  providers: [AdminDashboardService],
})
export class AdminDashboardModule {}
