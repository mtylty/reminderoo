require('dotenv').config();
const { WebClient } = require('@slack/web-api');
const { google } = require('googleapis');
const schedule = require('node-schedule');
const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Handlebars = require('handlebars');

// Add a simple logging utility
function log(message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}

// Add logging to initialization
log('🦘 Reminderoo is starting up...');

// Initialize Slack client
log('Initializing Slack client...');
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// Configure Google Calendar API
log('Configuring Google Calendar API...');
const calendar = google.calendar({
  version: 'v3',
  auth: new google.auth.JWT(
    process.env.GOOGLE_CLIENT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/calendar.readonly']
  )
});

// Configure HiBob API client
log('Configuring HiBob client...');
const hibob = axios.create({
  baseURL: process.env.HIBOB_BASE_URL,
  headers: {
    'Authorization': `Bearer ${process.env.HIBOB_API_KEY}`,
    'Content-Type': 'application/json'
  }
});

// Load notification configuration
log('Loading notification configuration...');
const notificationConfig = yaml.load(
  fs.readFileSync(path.join(__dirname, 'config', 'notifications.yml'), 'utf8')
);
log('Notification config loaded:', notificationConfig);

// Template cache
const templates = {};

// Load and compile template
function getTemplate(templateName) {
  if (!templates[templateName]) {
    const templatePath = path.join(__dirname, 'config', 'templates', templateName);
    const templateContent = fs.readFileSync(templatePath, 'utf8');
    templates[templateName] = Handlebars.compile(templateContent);
  }
  return templates[templateName];
}

// Format event data for templates
function formatEventData(event) {
  const startTime = new Date(event.start.dateTime || event.start.date);
  return {
    eventTitle: event.summary,
    eventTime: startTime.toLocaleString(),
    eventLocation: event.location || '',
    eventDescription: event.description || '',
    eventLink: event.htmlLink || ''
  };
}

// Send notification based on type
async function sendNotification(event, notificationConfig) {
  const template = getTemplate(notificationConfig.template);
  const eventData = formatEventData(event);
  const message = template(eventData);

  if (notificationConfig.type === 'slack') {
    await sendSlackMessage(message);
  } else if (notificationConfig.type === 'hibob') {
    await sendHiBobShoutout(message);
  }
}

async function sendSlackMessage(message) {
  try {
    log('Sending Slack message:', { channel: process.env.SLACK_CHANNEL_ID, message });
    await slack.chat.postMessage({
      channel: process.env.SLACK_CHANNEL_ID,
      text: message,
      parse: 'mrkdwn'
    });
    log('✅ Slack message sent successfully');
  } catch (error) {
    log('❌ Error sending Slack message:', {
      message: error.message,
      code: error.code,
      stack: error.stack
    });
  }
}

async function sendHiBobShoutout(message) {
  try {
    log('Sending HiBob shoutout:', { message });
    await hibob.post('/shoutouts', {
      text: message,
      type: process.env.HIBOB_SHOUTOUT_TYPE,
      visibility: process.env.HIBOB_SHOUTOUT_VISIBILITY
    });
    log('✅ HiBob shoutout sent successfully');
  } catch (error) {
    log('❌ Error sending HiBob shoutout:', {
      message: error.message,
      response: error.response?.data,
      stack: error.stack
    });
  }
}

// Function to convert natural language time to minutes
function parseTimeToMinutes(timeString) {
  const [amount, unit, ] = timeString.split(' ');
  switch (unit) {
    case 'day':
    case 'days':
      return parseInt(amount) * 24 * 60;
    case 'hour':
    case 'hours':
      return parseInt(amount) * 60;
    case 'minute':
    case 'minutes':
      return parseInt(amount);
    default:
      throw new Error(`Unsupported time unit: ${unit}`);
  }
}

// Convert notification times to minutes
const NOTIFICATION_TIMES = notificationConfig.notifications.map(notification => ({
  minutes: parseTimeToMinutes(notification.time),
  originalTime: notification.time
}));

// Function to fetch upcoming events
async function getUpcomingEvents() {
  try {
    log('Fetching upcoming events...');
    const response = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      timeMin: new Date().toISOString(),
      maxResults: parseInt(process.env.APP_MAX_EVENTS),
      singleEvents: true,
      orderBy: 'startTime',
    });
    log(`Found ${response.data.items.length} upcoming events:`, response.data.items);
    return response.data.items;
  } catch (error) {
    log('❌ Error fetching calendar events:', {
      message: error.message,
      code: error.code,
      stack: error.stack
    });
    return [];
  }
}

// Function to schedule reminders
async function scheduleReminders() {
  log('Starting to schedule reminders...');
  const events = await getUpcomingEvents();
  
  events.forEach(event => {
    const startTime = new Date(event.start.dateTime || event.start.date);
    log(`Processing event: ${event.summary}`, { startTime });
    
    NOTIFICATION_TIMES.forEach(notification => {
      const reminderTime = new Date(startTime.getTime() - notification.minutes * 60000);
      
      if (reminderTime > new Date()) {
        log(`Scheduling notification for "${event.summary}"`, {
          notificationTime: reminderTime,
          timeUntilNotification: `${notification.originalTime}`
        });
        
        schedule.scheduleJob(reminderTime, () => {
          log(`⏰ Executing scheduled notification for "${event.summary}"`);
          sendNotification(event, notification);
        });
      } else {
        log(`Skipping past notification time for "${event.summary}"`, {
          reminderTime,
          currentTime: new Date()
        });
      }
    });
  });
  log('Finished scheduling reminders');
}

// Add logging to the initial setup
log(`Setting up scheduler with interval: ${process.env.APP_CHECK_INTERVAL}`);
schedule.scheduleJob(process.env.APP_CHECK_INTERVAL, () => {
  log('Running scheduled check for new events...');
  scheduleReminders();
});

// Initial run
log('Performing initial run...');
scheduleReminders();

log('🦘 Reminderoo is fully initialized and hopping into action!'); 