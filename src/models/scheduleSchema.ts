import mongoose, { Schema } from "mongoose";

export interface ISchedule {
  name: string;
  runAt: Date;
  completed: boolean;
  createdBy: mongoose.Types.ObjectId;
  lastRun?: Date;
  lastError?: string;
}

const ScheduleSchema = new Schema<ISchedule>(
  {
    name: { type: String, required: true },
    runAt: { type: Date, required: true },
    completed: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    lastRun: { type: Date,},
    lastError: { type: String },
  },
  { timestamps: true }
);

const Schedule = mongoose.model<ISchedule>("Schedule", ScheduleSchema);
export default Schedule;
