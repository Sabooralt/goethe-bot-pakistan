import mongoose from "mongoose";

export interface Slot {
  date: string;
  location: string;
  price: string;
  btnId: string;
}

export interface States {
  IDLE: string;
  ADDING_ACCOUNT: string;
  REMOVING_ACCOUNT: string;
  TOGGLING_ACCOUNT: string;
  SELECTING_COUNTRY: string;
  SELECTING_APPLICATION_CENTER: string;
  SELECTING_APP_CATEGORY: string;
  SELECTING_SUB_CATEGORY: string;
}

type User = {
  telegramId: string;
  username: string;
  createdAt: Date;
};
export interface Account {
  user: User;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  
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
  createdAt: Date;
}
