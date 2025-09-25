import { examMonitor, pollExamApi } from "../api/exam-api-finder";
import { runAllAccounts } from "../cluster/runCluster";

(async () => {
  await examMonitor.startPolling(new Date("2025-09-11T07:30:00.000+00:00"), {
    onExamWithOid: async (exam) => {
      console.log(`🎯 Processing exam with OID:`, exam.oid);

      try {
        if (exam.oid) {
          // Run your booking automation
          await runAllAccounts(exam.oid);
          // Note: Success notification is handled in runAllAccounts
        } else {
          const errorMsg = "No OID found on exam";
          console.log(`❌  ${errorMsg}`);
        }
      } catch (automationError) {
        console.error(`❌ Automation failed:`, automationError);
      }
    },
  });
})();
