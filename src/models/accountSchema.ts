import mongoose, { Types } from "mongoose";
import { UserDocument } from "./userSchema";

export interface AccountDocument extends Document {
  user: Types.ObjectId | UserDocument;
  email: string;
  firstName: string;
  lastName: string;
  status: boolean;
  password: string;
  modules: {
    read: boolean;
    hear: boolean;
    write: boolean;
    speak: boolean;
  };
  details: {
    dob: {
      day: number;
      month: number;
      year: number;
    };
    address: {
      street: string;
      city: string;
      postalCode: string;
      houseNo: string;
    };
    phone: {
      countryCode: string;
      number: string;
    };
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
    firstName: {
      type: String,
      required: true,
    },
    lastName: {
      type: String,
      required: true,
    },
    modules: {
      read: { type: Boolean, default: false },
      hear: { type: Boolean, default: false },
      write: { type: Boolean, default: false },
      speak: { type: Boolean, default: false },
    },
    details: {
      dob: {
        day: { type: Number, required: true },
        month: { type: Number, required: true },
        year: { type: Number, required: true },
      },
      address: {
        street: { type: String, required: true },
        city: { type: String, required: true },
        postalCode: { type: String, required: true },
        houseNo: { type: String, required: true },
      },
      phone: {
        countryCode: { type: String, required: true },
        number: { type: String, required: true },
      },
    },
  },
  {
    timestamps: true,
  }
);
const Account = mongoose.model<AccountDocument>("Account", accountSchema);

export default Account;
