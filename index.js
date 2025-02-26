require('dotenv').config();
const { WebClient } = require('@slack/web-api');
const { google } = require('googleapis');
const schedule = require('node-schedule');
const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Handlebars = require('handlebars');

// Initialize Slack client
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// Configure Google Calendar API
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
const hibob = axios.create({
  baseURL: process.env.HIBOB_BASE_URL,
  headers: {
    'Authorization': `Bearer ${process.env.HIBOB_API_KEY}`,
    'Content-Type': 'application/json'
  }
});

// Load notification configuration
const notificationConfig = yaml.load(
  fs.readFileSync(path.join(__dirname, 'config', 'notifications.yml'), 'utf8')
);

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
    await slack.chat.postMessage({
      channel: process.env.SLACK_CHANNEL_ID,
      text: message,
      parse: 'mrkdwn'
    });
  } catch (error) {
    console.error('Error sending Slack message:', error);
  }
}

async function sendHiBobShoutout(message) {
  try {
    await hibob.post('/shoutouts', {
      text: message,
      type: process.env.HIBOB_SHOUTOUT_TYPE,
      visibility: process.env.HIBOB_SHOUTOUT_VISIBILITY
    });
  } catch (error) {
    console.error('Error sending HiBob shoutout:', error);
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
    const response = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      timeMin: new Date().toISOString(),
      maxResults: parseInt(process.env.APP_MAX_EVENTS),
      singleEvents: true,
      orderBy: 'startTime',
    });
    return response.data.items;
  } catch (error) {
    console.error('Error fetching calendar events:', error);
    return [];
  }
}

// Function to schedule reminders
async function scheduleReminders() {
  const events = await getUpcomingEvents();
  
  events.forEach(event => {
    const startTime = new Date(event.start.dateTime || event.start.date);
    
    NOTIFICATION_TIMES.forEach(notification => {
      const reminderTime = new Date(startTime.getTime() - notification.minutes * 60000);
      
      if (reminderTime > new Date()) {
        schedule.scheduleJob(reminderTime, () => {
          sendNotification(event, notification);
        });
      }
    });
  });
}

// Update the scheduler to use the configured check interval
schedule.scheduleJob(process.env.APP_CHECK_INTERVAL, scheduleReminders);

// Initial run
scheduleReminders();

console.log('🦘 Reminderoo is hopping into action!'); 