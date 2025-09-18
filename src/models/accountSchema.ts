import mongoose from "mongoose";
const accountSchema = new mongoose.Schema(
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
const Account = mongoose.model("Account", accountSchema);

export default Account;
