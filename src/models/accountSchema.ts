import mongoose, { Document, Types } from "mongoose";
import { UserDocument } from "./userSchema";

export interface AccountDocument extends Document {
  user: Types.ObjectId | UserDocument;
  email: string;
  status: boolean;
  password: string;
  modules: {
    read: boolean;
    hear: boolean;
    write: boolean;
    speak: boolean;
  };
} 
const accountSchema = new mongoose.Schema<AccountDocument>(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    status: {
      type: Boolean,
      default: true,
    },
    email: {
      type: String,
      required: true,
    },
    password: {
      type: String,
      required: true,
    },

    modules: {
      read: { type: Boolean, default: false },
      hear: { type: Boolean, default: false },
      write: { type: Boolean, default: false },
      speak: { type: Boolean, default: false },
    },
  },
  {
    timestamps: true,
  }
);
const Account = mongoose.model<AccountDocument>("Account", accountSchema);

export default Account;
