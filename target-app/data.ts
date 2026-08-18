export interface Account {
  accountNo: string;
  type: string;
  status: string;
  balance: number;
}

export interface Member {
  id: string;
  name: string;
  branch: string;
  status: string;
  restricted?: boolean;
  accounts: Account[];
}

export const members: Record<string, Member> = {
  "10001": {
    id: "10001",
    name: "Ada Exampleton",
    branch: "Harbor Demo Branch",
    status: "Active",
    accounts: [
      { accountNo: "90000001", type: "Savings", status: "Open", balance: 1250.75 },
    ],
  },
  "10002": {
    id: "10002",
    name: "Bixby Sample",
    branch: "North Demo Branch",
    status: "Active",
    accounts: [
      { accountNo: "90000002", type: "Checking", status: "Open", balance: 842.19 },
      { accountNo: "90000003", type: "Money Market", status: "Open", balance: 4100.0 },
    ],
  },
  "10003": {
    id: "10003",
    name: "Cleo Placeholder",
    branch: "Market Demo Branch",
    status: "Active",
    accounts: [
      { accountNo: "90000004", type: "Savings", status: "Open", balance: 95.4 },
    ],
  },
  "10004": {
    id: "10004",
    name: "Drew Fictional",
    branch: "West Demo Branch",
    status: "Review",
    accounts: [
      { accountNo: "90000005", type: "Checking", status: "Open", balance: 2375.0 },
      { accountNo: "90000006", type: "Savings", status: "Dormant", balance: 600.6 },
    ],
  },
  "10005": {
    id: "10005",
    name: "Eli Testerson",
    branch: "Central Demo Branch",
    status: "Active",
    accounts: [
      { accountNo: "90000007", type: "Savings", status: "Open", balance: 318.33 },
    ],
  },
  "10009": {
    id: "10009",
    name: "Restricted Example",
    branch: "Secure Demo Branch",
    status: "Restricted",
    restricted: true,
    accounts: [
      { accountNo: "90000008", type: "Savings", status: "Open", balance: 777.77 },
    ],
  },
};

export function getMember(id: string): Member | undefined {
  return members[id];
}
