/*************************************************
 * 1. The Setup & Imports
 *************************************************/
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { google, Auth, calendar_v3 } from "googleapis";
import { authenticate } from "@google-cloud/local-auth";
import path from "path";
import fs from "fs/promises";

// Explicitly typing our constants
const SCOPES: string[] = ['https://www.googleapis.com/auth/calendar.readonly'];
const TOKEN_PATH: string = path.join(process.cwd(), 'token.json');
const CREDENTIALS_PATH: string = path.join(process.cwd(), 'credentials_gcp.json');


/*************************************************
 * 2. The Authentication Loop (Strictly Typed)
 *************************************************/

// We use Auth.AuthClient as the base type for any client returned by fromJSON
async function loadSavedCredentialsIfExist(): Promise<Auth.AuthClient | null> {
  try {
    const content: string = await fs.readFile(TOKEN_PATH, 'utf-8');
    const credentials = JSON.parse(content);
    // fromJSON returns an AuthClient (the parent class for all Google auth types)
    return google.auth.fromJSON(credentials);
  } catch (err) {
    return null;
  }
}

// We use OAuth2Client specifically here because that's what the local-auth 
// package generates during the initial browser login.
async function saveCredentials(client: Auth.OAuth2Client): Promise<void> {
  const payload: string = JSON.stringify({
    type: 'authorized_user',
    client_id: client._clientId,
    client_secret: client._clientSecret,
    refresh_token: client.credentials.refresh_token,
  });
  await fs.writeFile(TOKEN_PATH, payload);
}

async function authorize(): Promise<Auth.AuthClient> {
  const savedClient = await loadSavedCredentialsIfExist();
  if (savedClient) {
    return savedClient;
  }

  console.error("No token found. Opening browser for authentication...");
  
  // The 'authenticate' helper specifically returns an OAuth2Client
  const client: Auth.OAuth2Client = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  });

  if (client.credentials) {
    await saveCredentials(client);
  }
  return client;
}

/*************************************************
 * 3. Initializing the MCP Server
 *************************************************/
const server: Server = new Server({
  name: "google-calendar-mcp",
  version: "1.0.0"
}, {
  capabilities: { tools: {} }
});


/*************************************************
 * 4. Defining the "Instruction Manual" (ListTools)
 *************************************************/
// Explicitly typing the Tool definition
const getUpcomingMeetingsTool: Tool = {
  name: "get_upcoming_meetings",
  description: "Fetches upcoming Google Calendar events. Defaults to the next 24 hours.",
  inputSchema: {
    type: "object",
    properties: {
      days_ahead: { 
        type: "number", 
        description: "How many days ahead to look", 
        default: 1 
      }
    }
  }
};

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: [getUpcomingMeetingsTool] };
});


/*************************************************
 * 5. Executing the Request (CallTool)
 *************************************************/
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "get_upcoming_meetings") {
    
    // Defining the exact interface we expect from Claude's request
    interface MeetingArgs {
      days_ahead?: number;
    }
    
    const args = request.params.arguments as MeetingArgs | undefined;
    const daysAhead: number = args?.days_ahead ?? 1;
    
    const auth = await authorize();
    const calendar: calendar_v3.Calendar = google.calendar({ version: 'v3', auth });

    const now: Date = new Date();
    const end: Date = new Date();
    end.setDate(now.getDate() + daysAhead);

    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: end.toISOString(),
      maxResults: 15,
      singleEvents: true,
      orderBy: 'startTime',
    });

    // Explicitly typing the events array using Google's schema
    const events: calendar_v3.Schema$Event[] | undefined = res.data.items;
    
    if (!events || events.length === 0) {
      return { 
        content: [{ type: "text", text: "You have no upcoming events in this timeframe." }] 
      };
    }

    // Typing the map function and string variables
    const optimizedEvents: string[] = events.map((event: calendar_v3.Schema$Event) => {
      const start: string | null | undefined = event.start?.dateTime || event.start?.date;
      const title: string | null | undefined = event.summary || "Untitled Event";
      return `- ${title} at ${start}`;
    });

    return { 
      content: [{ type: "text", text: optimizedEvents.join("\n") }] 
    };
  }
  
  throw new Error("Tool not found");
});


/*************************************************
 * 6. Starting the Connection (Stdio Transport)
 *************************************************/
async function main(): Promise<void> {
  await authorize();
  
  const transport: StdioServerTransport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Google Calendar MCP Server running on stdio");
}

main().catch(console.error);