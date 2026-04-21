import { bot } from "..";
import { examMonitor } from "../api/exam-api-finder";
import { runAllAccounts } from "../cluster/runCluster";
import Schedule, { ISchedule } from "../models/scheduleSchema";
import User from "../models/userSchema";
import { DateTime } from "luxon";

interface ActiveSession {
  scheduleId: string;
  targetTime: Date;
  startedAt: Date;
  userId?: string; // Add userId for better tracking
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
        console.error("Scheduler error:", error);
      }
    }, 30000); // Check every 30 seconds

    // Initial check on startup
    this.checkAndStartMonitoring().catch((error) => {
      console.error("Initial scheduler check failed:", error);
    });

    console.log("Exam scheduler started successfully");
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
    console.log("Exam scheduler stopped");
  }

  /**
   * Checks for schedules that need monitoring and starts them
   */
  private async checkAndStartMonitoring(): Promise<void> {
    try {
      const nowUtc = DateTime.utc().toJSDate();

      // Monitoring starts 2 minutes from now (UTC)
      const monitoringStartTimeUtc = DateTime.utc()
        .plus({ minutes: 2 })
        .toJSDate();
      // Find schedules that need monitoring to start (2 minutes before exam time)
      const schedulesToMonitor = await Schedule.find({
        runAt: {
          $gte: nowUtc, // Exam time is in the future
          $lte: monitoringStartTimeUtc, // But monitoring should start within 2 minutes
        },
        completed: false,
        status: { $ne: "running" }, // Not already running
        monitoringStarted: { $ne: true }, // Not already monitoring
      }).populate("createdBy");

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
            `Failed to start monitoring for schedule ${schedule._id}:`,
            error
          );
          await this.updateScheduleWithError(
            schedule.id,
            error,
            "Failed to start monitoring"
          );
        }
      }

      // Clean up completed monitoring sessions
      await this.cleanupCompletedSessions();
    } catch (error) {
      console.error("Error checking schedules:", error);
    }
  }

  /**
   * Starts monitoring for a specific schedule
   */
  private async startMonitoringForSchedule(schedule: ISchedule): Promise<void> {
    const scheduleId = schedule.id.toString();

    // Check if already monitoring this schedule
    if (this.activeMonitoringSessions.has(scheduleId)) {
      console.log(
        `⚠️ Already monitoring schedule ${schedule.name} (${scheduleId})`
      );
      return;
    }

    const user = await User.findById(schedule.createdBy);
    if (!user) {
      console.error(`User not found for schedule ${schedule.name}`);
      await this.updateScheduleWithError(
        scheduleId,
        "User not found",
        "User validation failed"
      );
      return;
    }

    // Send notification to user that monitoring is starting
    await this.sendLogToUser(
      user.telegramId,
      `🚀 **Monitoring Started**\n` +
        `📝 Schedule: ${schedule.name}\n` +
        `📅 Exam time: ${schedule.runAt.toLocaleString()}\n` +
        `🔄 Status: Starting to monitor for available slots...`
    );

    console.log(`🎯 Starting monitoring for schedule: ${schedule.name}`);
    console.log(`📅 Target exam time: ${schedule.runAt.toLocaleString()}`);

    // Mark as monitoring started in database
    await Schedule.findByIdAndUpdate(schedule._id, {
      status: "running",
      monitoringStarted: true,
      lastError: null, // Clear any previous errors
    });

    // Track the session
    this.activeMonitoringSessions.set(scheduleId, {
      scheduleId,
      targetTime: schedule.runAt,
      startedAt: new Date(),
      userId: user.telegramId,
    });

    try {
      // Start polling for this specific schedule
      await examMonitor.startPolling(schedule.runAt, {
        interval: 5000, // Poll every 5 seconds
        maxDurationMs: 30 * 60 * 1000, // Poll for maximum 30 minutes
        onExamFound: async (exam) => {
          console.log(`📋 [${schedule.name}] Exam detected:`, {
            modules: exam.modules?.length,
            hasOid: !!exam.oid,
            scheduleId: scheduleId,
          });

          // Notify user that exam was found but waiting for OID
          await this.sendLogToUser(
            user.telegramId,
            `📋 **Exam Found**\n` +
              `📝 Schedule: ${schedule.name}\n` +
              `Exam slot detected with ${
                exam.modules?.length || 0
              } modules\n` +
              `⏳ Waiting for booking to become available...`
          );
        },
        onExamWithOid: async (exam) => {
          console.log(
            `🎯 [${schedule.name}] Processing exam with OID:`,
            exam.oid
          );

          // Notify user that OID is found and automation is starting
          await this.sendLogToUser(
            user.telegramId,
            `🎯 **Booking Available!**\n` +
              `📝 Schedule: ${schedule.name}\n` +
              `🆔 OID: ${exam.oid}\n` +
              `🤖 Starting automated booking process...`
          );

          try {
            if (exam.oid) {
              // Run your booking automation
              await runAllAccounts(exam.oid, schedule.id);
              // Note: Success notification is handled in runAllAccounts
            } else {
              const errorMsg = "No OID found on exam";
              console.log(`[${schedule.name}] ${errorMsg}`);
              await this.updateScheduleWithError(
                scheduleId,
                errorMsg,
                "OID validation failed"
              );
            }
          } catch (automationError) {
            console.error(
              `[${schedule.name}] Automation failed:`,
              automationError
            );
            await this.updateScheduleWithError(
              scheduleId,
              automationError,
              "Automation failed"
            );
          }

          // Remove from active sessions
          this.activeMonitoringSessions.delete(scheduleId);
        },
        onTimeout: async () => {
          // Handle timeout - no exam found within 30 minutes
          console.log(
            `⏰ [${schedule.name}] Polling timeout - no exam found within 30 minutes`
          );

          await this.sendLogToUser(
            user.telegramId,
            `⏰ **Schedule Timeout**\n` +
              `📝 Schedule: ${schedule.name}\n` +
              `No exam slots found within 5 hours\n` +
              `💡 The exam might not be available yet. You can create a new schedule to try again later.`
          );

          // Update schedule status
          await Schedule.findByIdAndUpdate(scheduleId, {
            status: "failed",
            completed: true,
            lastError: "No exam found within 30 minute monitoring window",
            lastRun: new Date(),
          });

          // Remove from active sessions
          this.activeMonitoringSessions.delete(scheduleId);
        },
        stopOnFirstOid: true,
      });
    } catch (monitoringError) {
      console.error(
        `Failed to start polling for schedule ${schedule.name}:`,
        monitoringError
      );

      // Remove from active sessions and update database
      this.activeMonitoringSessions.delete(scheduleId);
      await this.updateScheduleWithError(
        scheduleId,
        monitoringError,
        "Failed to start polling"
      );

      throw monitoringError;
    }
  }

  /**
   * Helper method to update schedule with error and notify user
   */
  private async updateScheduleWithError(
    scheduleId: string,
    error: any,
    context: string
  ): Promise<void> {
    const errorMessage =
      (error as any).message || error.toString() || "Unknown error";

    await Schedule.findByIdAndUpdate(scheduleId, {
      monitoringStarted: false,
      status: "failed",
      lastError: `${context}: ${errorMessage}`,
      lastRun: new Date(),
    });

    // Get user and send error notification
    const schedule = await Schedule.findById(scheduleId).populate("createdBy");
    if (schedule?.createdBy) {
      const user = schedule.createdBy as any;
      if (user.telegramId) {
        await this.sendLogToUser(
          user.telegramId,
          `**Schedule Error**\n` +
            `📝 Schedule: ${schedule.name}\n` +
            `🚨 Error: ${context}\n` +
            `💬 Details: ${errorMessage}\n` +
            `⏰ Time: ${new Date().toLocaleString()}`
        );
      }
    }
  }

  /**
   * Helper method to send log messages to users
   */
  private async sendLogToUser(
    telegramId: string,
    message: string
  ): Promise<void> {
    try {
      await bot.sendMessage(telegramId, message, { parse_mode: "Markdown" });
    } catch (error) {
      console.error(`Failed to send log to user ${telegramId}:`, error);
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
      const session = this.activeMonitoringSessions.get(scheduleId);
      this.activeMonitoringSessions.delete(scheduleId);

      // Update database to reflect that monitoring is no longer active
      try {
        await Schedule.findByIdAndUpdate(scheduleId, {
          status: "failed",
          lastError: "Monitoring session expired - exam time has passed",
          lastRun: new Date(),
        });

        // Notify user about expiration
        if (session?.userId) {
          const schedule = await Schedule.findById(scheduleId);
          if (schedule) {
            await this.sendLogToUser(
              session.userId,
              `⏰ **Schedule Expired**\n` +
                `📝 Schedule: ${schedule.name}\n` +
                `Monitoring stopped - exam time has passed\n` +
                `💡 You can create a new schedule for future exams.`
            );
          }
        }
      } catch (error) {
        console.error(
          `Failed to update expired schedule ${scheduleId}:`,
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

    // Notify all users before stopping
    for (const [
      scheduleId,
      session,
    ] of this.activeMonitoringSessions.entries()) {
      if (session.userId) {
        const schedule = await Schedule.findById(scheduleId);
        if (schedule) {
          await this.sendLogToUser(
            session.userId,
            `🛑 **System Shutdown**\n` +
              `📝 Schedule: ${schedule.name}\n` +
              `⚠️ Monitoring stopped due to system shutdown\n` +
              `💡 Your schedule will resume when the system restarts.`
          );
        }
      }
    }

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
          status: "pending", // Reset to pending so they can be picked up again
          lastError: "Monitoring stopped by system shutdown",
        }
      );
    } catch (error) {
      console.error("Failed to reset monitoring flags:", error);
    }
  }

  /**
   * Manually trigger monitoring for a specific schedule (useful for testing)
   */
  async triggerSchedule(scheduleId: string): Promise<void> {
    try {
      const schedule = await Schedule.findById(scheduleId).populate(
        "createdBy"
      );
      if (!schedule) {
        throw new Error(`Schedule ${scheduleId} not found`);
      }

      if (schedule.completed) {
        throw new Error(`Schedule ${scheduleId} is already completed`);
      }

      // Reset schedule status
      await Schedule.findByIdAndUpdate(scheduleId, {
        status: "pending",
        monitoringStarted: false,
        lastError: null,
      });

      await this.startMonitoringForSchedule(schedule);
      console.log(
        `Manually triggered monitoring for schedule ${scheduleId}`
      );
    } catch (error) {
      console.error(
        `Failed to manually trigger schedule ${scheduleId}:`,
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
    const schedule = await Schedule.findById(scheduleId).populate("createdBy");
    const session = this.activeMonitoringSessions.get(scheduleId);

    return {
      schedule,
      isMonitoring: !!session,
      session,
    };
  }

  /**
   * Send schedule logs to user (public method)
   */
  async sendScheduleLog(scheduleId: string, message: string): Promise<void> {
    try {
      const schedule = await Schedule.findById(scheduleId).populate(
        "createdBy"
      );
      if (schedule?.createdBy) {
        const user = schedule.createdBy as any;
        if (user.telegramId) {
          await this.sendLogToUser(user.telegramId, message);
        }
      }
    } catch (error) {
      console.error(`Failed to send schedule log for ${scheduleId}:`, error);
    }
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
