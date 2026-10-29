# Access request for employee activity tracking

Please create the access below and send it back to us. These are the keys Ops Engine needs to read employee activity from Warehance, Slack, and Google Workspace.

We use them as evidence next to the badge clock. They do not replace punch in and punch out, and they do not change any hours already recorded.

Please send the keys by private email or a password manager. Do not paste them in a public Slack channel.

## 1. Warehance — one API key

Ask a Warehance admin to create a **read-only organization API key**.

The key needs read access to:

- Users
- Orders
- Shipments
- Inbound and receiving
- Activity history

Please also confirm two things about pick and pack records:

- Does each record include the employee id?
- Does each record include the date and time of the pick or pack?

We will store the employee and the timestamp when both are present, and only for someone who is already clocked in. If the employee is missing, we keep the badge record and do not create hours.

**Send us:** the read-only API key.

## 2. Slack — two tokens

Slack does not have an existing API key to copy. A Workspace Owner creates an app, installs it, and Slack generates the tokens. The workspace must be on **Business+ or Enterprise**. Those tokens are the keys.

### Steps

1. Open [https://api.slack.com/apps](https://api.slack.com/apps) and choose **Create New App** → **From scratch**.
2. Name the app `Ops Engine Activity` and select the company workspace.
3. Open **OAuth & Permissions**.
4. Under **Bot Token Scopes**, add:
   - `users:read`
   - `users:read.email`
5. Under **User Token Scopes**, add:
   - `admin.analytics:read`
6. Click **Install to Workspace** and approve it. The person who installs it must be a Workspace Owner or Workspace Admin.
7. Copy both tokens from the same OAuth page.

### What to send

| Token | Starts with | What we use it for |
|---|---|---|
| Bot User OAuth Token | `xoxb-` | Match each Slack account to an employee by name and work email |
| User OAuth Token | `xoxp-` | Read one activity row per person per day |

### What we will track

For each person and each date:

- Whether they were active that day
- Whether they used desktop, iPhone, or Android
- Number of messages posted
- Number of huddles and calls

Slack does not provide a start time or an end time. We will not read or send messages.

## 3. Google Workspace — one JSON key file

A normal Google Cloud “API key” cannot read employee activity. A Super Admin creates a service account and downloads a JSON file. That file is the key.

### Steps

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project named `Ops Engine Activity`.
2. Enable the **Admin SDK API**.
3. Go to **IAM & Admin → Service accounts → Create service account**. Name it `ops-engine-activity`.
4. Open that service account, choose **Keys → Add key → Create new key → JSON**, and download the file.
5. Copy the service account **Client ID** (a number).
6. In [Google Admin](https://admin.google.com/), go to **Security → Access and data control → API controls → Domain-wide delegation → Add new**.
7. Paste the Client ID and add these scopes as one comma-separated line:

```
https://www.googleapis.com/auth/admin.reports.audit.readonly,https://www.googleapis.com/auth/admin.reports.usage.readonly,https://www.googleapis.com/auth/admin.directory.user.readonly
```

8. Save.

### What to send

- The downloaded JSON key file
- The Client ID you approved
- Confirmation that domain-wide delegation is saved

### What we will track

For each person and each date:

- Sign-in times
- The first and last time we saw activity
- Drive edits, Meet calls, and Calendar activity times
- The daily summary, including last sign-in

We will not read Gmail. Closing a laptop usually does not create a sign-out, so Google cannot close a shift.

## What to send back

| System | Send this |
|---|---|
| Warehance | Read-only organization API key, plus yes/no on employee id and timestamp for picks and packs |
| Slack | Bot token (`xoxb-`) and admin user token (`xoxp-`) |
| Google Workspace | Service account JSON file, Client ID, and confirmation that the three scopes are approved |

This request does not include QuickBooks. Please do not send a QuickBooks password or key.

## What these keys are for

| System | Who it covers | What it adds |
|---|---|---|
| Warehance | Warehouse | Pick and pack time, only when the record has an employee and a timestamp |
| Slack | Sales | Proof the person was active that day, with message and call counts |
| Google Workspace | Office and client services | Sign-in and work-activity times during the day |

Paid hours stay on the Ops Engine badge clock. These three sources explain what the person was doing. They do not create paid hours on their own.
