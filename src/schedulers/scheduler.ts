import { examMonitor } from "../api/exam-api-finder";
import { runAllAccounts } from "../cluster/runCluster";
import Schedule, { ISchedule } from "../models/scheduleSchema";

interface ActiveSession {
  scheduleId: string;
  targetTime: Date;
  startedAt: Date;
}

class ExamScheduler {
  private activeMonitoringSessions = new Map<string, ActiveSession>();
  private schedulerInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

  /**
   * Starts the main scheduler
   */
  start(): void {
    if (this.isRunning) {
      console.log("⚠️ Scheduler is already running");
      return;
    }

    console.log("🚀 Starting exam scheduler...");
    this.isRunning = true;

    // Main scheduler loop - runs every 30 seconds for better responsiveness
    this.schedulerInterval = setInterval(async () => {
      try {
        await this.checkAndStartMonitoring();
      } catch (error) {
        console.error("❌ Scheduler error:", error);
      }
    }, 30000); // Check every 30 seconds

    // Initial check on startup
    this.checkAndStartMonitoring().catch((error) => {
      console.error("❌ Initial scheduler check failed:", error);
    });

    console.log("✅ Exam scheduler started successfully");
  }

  /**
   * Stops the scheduler
   */
  stop(): void {
    if (!this.isRunning) {
      console.log("⚠️ Scheduler is not running");
      return;
    }

    console.log("🛑 Stopping exam scheduler...");

    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
    }

    this.isRunning = false;
    console.log("✅ Exam scheduler stopped");
  }

  /**
   * Checks for schedules that need monitoring and starts them
   */
  private async checkAndStartMonitoring(): Promise<void> {
    try {
      const now = new Date();
      const monitoringStartTime = new Date(now.getTime() + 2 * 60 * 1000); // 2 minutes from now

      // Find schedules that need monitoring to start (2 minutes before exam time)
      const schedulesToMonitor = await Schedule.find({
        runAt: {
          $gte: now, // Exam time is in the future
          $lte: monitoringStartTime, // But monitoring should start within 2 minutes
        },
        completed: false,
        monitoringStarted: { $ne: true }, // Not already monitoring
      });

      if (schedulesToMonitor.length > 0) {
        console.log(
          `🔍 Found ${schedulesToMonitor.length} schedules ready for monitoring`
        );
      }

      for (const schedule of schedulesToMonitor) {
        try {
          await this.startMonitoringForSchedule(schedule);
        } catch (error) {
          console.error(
            `❌ Failed to start monitoring for schedule ${schedule._id}:`,
            error
          );
          await Schedule.findByIdAndUpdate(schedule._id, {
            lastError: (error as any).message || "Failed to start monitoring",
          });
        }
      }

      // Clean up completed monitoring sessions
      await this.cleanupCompletedSessions();
    } catch (error) {
      console.error("❌ Error checking schedules:", error);
    }
  }

  /**
   * Starts monitoring for a specific schedule
   */
  private async startMonitoringForSchedule(
    schedule: ISchedule
  ): Promise<void> {
    const scheduleId = schedule.id.toString();

    // Check if already monitoring this schedule
    if (this.activeMonitoringSessions.has(scheduleId)) {
      console.log(
        `⚠️ Already monitoring schedule ${schedule.name} (${scheduleId})`
      );
      return;
    }

    console.log(`🎯 Starting monitoring for schedule: ${schedule.name}`);
    console.log(`📅 Target exam time: ${schedule.runAt.toLocaleString()}`);

    // Mark as monitoring started in database
    await Schedule.findByIdAndUpdate(schedule._id, {
      monitoringStarted: true,
    });

    // Track the session
    this.activeMonitoringSessions.set(scheduleId, {
      scheduleId,
      targetTime: schedule.runAt,
      startedAt: new Date(),
    });

    try {
      // Start polling for this specific schedule
      await examMonitor.startPolling(schedule.runAt, {
        interval: 5000, // Poll every 5 seconds
        onExamFound: (exam) => {
          console.log(`📋 [${schedule.name}] Exam detected:`, {
            modules: exam.modules?.length,
            hasOid: !!exam.oid,
            scheduleId: scheduleId,
          });
        },
        onExamWithOid: async (exam) => {
          console.log(
            `🎯 [${schedule.name}] Processing exam with OID:`,
            exam.oid
          );

          try {
            if (exam.oid) {
              // Run your booking automation
              await runAllAccounts(exam.oid);

              // Mark schedule as completed
              await Schedule.findByIdAndUpdate(schedule._id, {
                completed: true,
                lastRun: new Date(),
                lastError: null, // Clear any previous errors
              });

              console.log(`✅ [${schedule.name}] Successfully completed!`);
            } else {
              console.log(
                `❌ [${schedule.name}] No OID found on exam, skipping runAllAccounts.`
              );
            }
          } catch (automationError) {
            console.error(
              `❌ [${schedule.name}] Automation failed:`,
              automationError
            );
            await Schedule.findByIdAndUpdate(schedule._id, {
              lastError:
                (automationError as any).message || "Automation failed",
            });
          }

          // Remove from active sessions
          this.activeMonitoringSessions.delete(scheduleId);
        },
        stopOnFirstOid: true,
      });
    } catch (monitoringError) {
      console.error(
        `❌ Failed to start polling for schedule ${schedule.name}:`,
        monitoringError
      );

      // Remove from active sessions and update database
      this.activeMonitoringSessions.delete(scheduleId);
      await Schedule.findByIdAndUpdate(schedule._id, {
        monitoringStarted: false,
        lastError:
          (monitoringError as any).message || "Failed to start polling",
      });

      throw monitoringError;
    }
  }

  /**
   * Cleans up expired or completed monitoring sessions
   */
  private async cleanupCompletedSessions(): Promise<void> {
    const now = new Date();
    const expiredSessions: string[] = [];

    for (const [
      scheduleId,
      session,
    ] of this.activeMonitoringSessions.entries()) {
      // If the target time has passed by more than 30 minutes, consider it expired
      const expiryTime = new Date(
        session.targetTime.getTime() + 30 * 60 * 1000
      );

      if (now > expiryTime) {
        expiredSessions.push(scheduleId);
        console.log(
          `🧹 Cleaning up expired monitoring session for schedule ${scheduleId}`
        );
      }
    }

    // Remove expired sessions
    for (const scheduleId of expiredSessions) {
      this.activeMonitoringSessions.delete(scheduleId);

      // Update database to reflect that monitoring is no longer active
      try {
        await Schedule.findByIdAndUpdate(scheduleId, {
          lastError: "Monitoring session expired",
        });
      } catch (error) {
        console.error(
          `❌ Failed to update expired schedule ${scheduleId}:`,
          error
        );
      }
    }

    if (expiredSessions.length > 0) {
      console.log(
        `🧹 Cleaned up ${expiredSessions.length} expired monitoring sessions`
      );
    }
  }

  /**
   * Gets the status of all active monitoring sessions
   */
  getStatus(): {
    isRunning: boolean;
    activeSessions: number;
    sessions: Array<{
      scheduleId: string;
      targetTime: string;
      startedAt: string;
      runningFor: string;
    }>;
  } {
    const now = new Date();
    const sessions = Array.from(this.activeMonitoringSessions.values()).map(
      (session) => ({
        scheduleId: session.scheduleId,
        targetTime: session.targetTime.toLocaleString(),
        startedAt: session.startedAt.toLocaleString(),
        runningFor: `${Math.round(
          (now.getTime() - session.startedAt.getTime()) / 1000
        )}s`,
      })
    );

    return {
      isRunning: this.isRunning,
      activeSessions: this.activeMonitoringSessions.size,
      sessions,
    };
  }

  /**
   * Emergency stop all monitoring sessions
   */
  async stopAllMonitoring(): Promise<void> {
    console.log(
      `🛑 Emergency stop: Stopping ${this.activeMonitoringSessions.size} active monitoring sessions`
    );

    // Stop the exam monitor
    examMonitor.destroy();

    // Clear all active sessions
    this.activeMonitoringSessions.clear();

    // Reset monitoring flags in database
    try {
      await Schedule.updateMany(
        { monitoringStarted: true, completed: false },
        {
          $unset: { monitoringStarted: 1 },
          lastError: "Monitoring stopped by system shutdown",
        }
      );
    } catch (error) {
      console.error("❌ Failed to reset monitoring flags:", error);
    }
  }

  /**
   * Manually trigger monitoring for a specific schedule (useful for testing)
   */
  async triggerSchedule(scheduleId: string): Promise<void> {
    try {
      const schedule = await Schedule.findById(scheduleId);
      if (!schedule) {
        throw new Error(`Schedule ${scheduleId} not found`);
      }

      if (schedule.completed) {
        throw new Error(`Schedule ${scheduleId} is already completed`);
      }

      await this.startMonitoringForSchedule(schedule);
      console.log(
        `✅ Manually triggered monitoring for schedule ${scheduleId}`
      );
    } catch (error) {
      console.error(
        `❌ Failed to manually trigger schedule ${scheduleId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Get detailed information about a specific schedule
   */
  async getScheduleInfo(scheduleId: string): Promise<{
    schedule: ISchedule | null;
    isMonitoring: boolean;
    session?: ActiveSession;
  }> {
    const schedule = await Schedule.findById(scheduleId);
    const session = this.activeMonitoringSessions.get(scheduleId);

    return {
      schedule,
      isMonitoring: !!session,
      session,
    };
  }
}

// Create and export singleton instance
const examScheduler = new ExamScheduler();

// Graceful shutdown handling
process.on("SIGINT", async () => {
  console.log("\n🛑 Received SIGINT, shutting down scheduler gracefully...");
  examScheduler.stop();
  await examScheduler.stopAllMonitoring();
});

process.on("SIGTERM", async () => {
  console.log("\n🛑 Received SIGTERM, shutting down scheduler gracefully...");
  examScheduler.stop();
  await examScheduler.stopAllMonitoring();
});

export { examScheduler, ExamScheduler };
