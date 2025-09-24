import mongoose, { Document, Schema } from "mongoose";

export interface ISchedule extends Document {
  name: string;
  runAt: Date;
  completed: boolean;
  createdBy: mongoose.Types.ObjectId;
  lastRun?: Date;
  lastError?: string;
  status: string;
  monitoringStarted: boolean;
}

const ScheduleSchema = new Schema<ISchedule>(
  {
    name: { type: String, required: true },
    runAt: { type: Date, required: true },
    completed: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    status: {
      type: String,
      enum: ["pending", "running", "success", "failed"],
      default: "pending",
    },
    lastRun: { type: Date },
    lastError: { type: String },
    monitoringStarted: { type: Boolean },
  },
  { timestamps: true }
);

const Schedule = mongoose.model<ISchedule>("Schedule", ScheduleSchema);
export default Schedule;
