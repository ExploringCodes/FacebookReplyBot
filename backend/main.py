import time 
from fastapi import FastAPI, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import requests
import logging
import google.generativeai as genai
import os
from typing import List, Optional, Dict, Any
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger
import re
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import FileResponse
from datetime import datetime, timedelta
import gspread
from google.oauth2 import service_account
import json
import tempfile
from dotenv import load_dotenv
import pytz


# Add these new imports instead
import threading
from datetime import datetime, timedelta
import time



app = FastAPI(title="Facebook Comment Reply Bot with Scheduler")

# Load environment variables from .env file
load_dotenv()

# Add CORS middleware to allow all origins, methods, and headers
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize scheduler
scheduler = BackgroundScheduler()
scheduler.start()

# Global variables
current_job = None
is_running = False
job_start_time = None  # Track when the job was started
preset_replies = {
    "hi there": "Hi there too!",
    "not so good": "We're sorry to hear that. Could you let us know what we can improve?",
    "how are you": "I'm doing well! How about you?",
    "rambunctious dinosaur": "That sounds like a wild dinosaur!",
    "শুভ কামনা রইলো": "Thank you!"
}
additional_instructions = ""

blacklisted_users = []  # Store blacklisted user names and IDs

# Add these new global variables instead
active_jobs = {}  # Store recurring job info
stop_flags = {}   # Control job stopping

# Update your request model


class BlacklistUser(BaseModel):
    user_id: Optional[str] = None
    user_name: Optional[str] = None

class BlacklistRequest(BaseModel):
    users: List[BlacklistUser]

class BlacklistClearRequest(BaseModel):
    clear_all: bool = False

class FacebookConfig(BaseModel):
    page_id: str
    access_token: str

class GoogleCredentials(BaseModel):
    credentials: dict
    sheet_name: str = "Sheet1"

class AIReplyRequest(BaseModel):
    config: FacebookConfig
    interval_seconds: int
    google_sheet_id: str
    google_credentials: GoogleCredentials
    stop_time_after: Optional[int] = None  # New field for auto-stop

class AdditionalPromptConfig(BaseModel):
    additional_instructions: str

class HeartbeatRequest(BaseModel):
    timestamp: str
    

def get_sheets_client(credentials_dict, temp_file=None):
    try:
        if temp_file is None:
            temp_file = tempfile.NamedTemporaryFile(delete=False, mode='w+')
            json.dump(credentials_dict, temp_file)
            temp_file.flush()
        
        creds = service_account.Credentials.from_service_account_file(
            temp_file.name, 
            scopes=['https://www.googleapis.com/auth/spreadsheets']
        )
        client = gspread.authorize(creds)
        return client, temp_file
    except Exception as e:
        logger.error(f"Error initializing Google Sheets client: {e}")
        if temp_file:
            try:
                os.unlink(temp_file.name)
            except:
                pass
        raise

def load_existing_replies(sheet_id: str, credentials_dict: dict, sheet_name: str) -> set:
    temp_file = None
    try:
        client, temp_file = get_sheets_client(credentials_dict)
        try:
            sheet = client.open_by_key(sheet_id).worksheet(sheet_name)
            values = sheet.get_all_values()
            if len(values) > 1:
                comment_id_idx = values[0].index("Comment ID")
                return set(row[comment_id_idx] for row in values[1:])
            return set()
        except gspread.exceptions.WorksheetNotFound:
            spreadsheet = client.open_by_key(sheet_id)
            worksheet = spreadsheet.add_worksheet(title=sheet_name, rows=1, cols=11)
            header = ["Post ID", "Post Content", "Post URL", "Post Time", "Comment ID", 
                     "Comment Content", "Comment URL", "Comment Time", "Commenter Name", "Reply"]
            worksheet.update([header])
            return set()
    except Exception as e:
        logger.error(f"Error loading existing replies from Google Sheets: {e}")
        return set()
    finally:
        if temp_file:
            try:
                os.unlink(temp_file.name)
            except:
                pass

def store_data_in_sheet(data: Dict[str, Any], sheet_id: str, credentials_dict: dict, sheet_name: str):
    temp_file = None
    try:
        client, temp_file = get_sheets_client(credentials_dict)
        spreadsheet = client.open_by_key(sheet_id)
        
        try:
            sheet = spreadsheet.worksheet(sheet_name)
            # Check if headers exist (first row is empty or doesn't match)
            existing_headers = sheet.row_values(1)
            expected_headers = ["Post ID", "Post Content", "Post URL", "Post Time", "Comment ID", 
                              "Comment Content", "Comment URL", "Comment Time", "Commenter Name", "Reply"]
            
            if not existing_headers or existing_headers != expected_headers:
                sheet.insert_row(expected_headers, index=1)
                logger.info(f"Added headers to existing sheet '{sheet_name}'")
                
        except gspread.exceptions.WorksheetNotFound:
            sheet = spreadsheet.add_worksheet(title=sheet_name, rows=1, cols=11)
            header = ["Post ID", "Post Content", "Post URL", "Post Time", "Comment ID", 
                     "Comment Content", "Comment URL", "Comment Time", "Commenter Name", "Reply"]
            sheet.update([header])
            logger.info(f"Created new sheet '{sheet_name}' with headers")

        row = [
            data.get("Post ID", ""),
            data.get("Post Content", ""),
            data.get("Post URL", ""),
            data.get("Post Time", ""),
            data.get("Comment ID", ""),
            data.get("Comment Content", ""),
            data.get("Comment URL", ""),
            data.get("Comment Time", ""),
            data.get("Commenter Name", ""),
            data.get("Reply", "")
        ]
        sheet.append_row(row)
        logger.info("Data stored in Google Sheets successfully.")
    except Exception as e:
        logger.error(f"Error storing data in Google Sheets: {e}")
        raise
    finally:
        if temp_file:
            try:
                os.unlink(temp_file.name)
            except:
                pass



def preset_replies_check(comment: str) -> Optional[str]:
    global preset_replies
    comment = re.sub(r"[^\w\s]", "", comment).lower()
    comment_words = set(comment.split())

    for keyword, reply in preset_replies.items():
        clean_keyword = re.sub(r"[^\w\s]", "", keyword).lower()
        keyword_words = set(clean_keyword.split())
        if len(keyword_words) == 0:
            continue  # Skip empty keywords to avoid division by zero
        if len(keyword_words.intersection(comment_words)) / len(keyword_words) >= 0.75:
            return reply
    return None



@app.post("/update-blacklisted-users")
async def update_blacklisted_users(request: BlacklistRequest):
    global blacklisted_users
    
    # Replace the entire blacklist with the new list
    blacklisted_users = request.users
    
    return {
        "status": "success", 
        "message": f"Blacklist updated with {len(blacklisted_users)} users",
        "blacklisted_users": blacklisted_users
    }

@app.post("/add-blacklisted-users")
async def add_blacklisted_users(request: BlacklistRequest):
    global blacklisted_users
    
    # Add only users that aren't already in the blacklist
    added_count = 0
    for user in request.users:
        # Check if this user is already in the blacklist
        if not any((existing.user_id == user.user_id and user.user_id is not None) or 
                  (existing.user_name == user.user_name and user.user_name is not None) 
                  for existing in blacklisted_users):
            blacklisted_users.append(user)
            added_count += 1
    
    return {
        "status": "success", 
        "message": f"Added {added_count} users to blacklist",
        "blacklisted_users": blacklisted_users
    }

@app.post("/remove-blacklisted-users")
async def remove_blacklisted_users(request: BlacklistRequest):
    global blacklisted_users
    
    removed_count = 0
    for user in request.users:
        initial_count = len(blacklisted_users)
        blacklisted_users = [u for u in blacklisted_users if 
                            not ((user.user_id and u.user_id == user.user_id) or 
                                (user.user_name and u.user_name == user.user_name))]
        removed_count += initial_count - len(blacklisted_users)
    
    return {
        "status": "success", 
        "message": f"Removed {removed_count} users from blacklist",
        "blacklisted_users": blacklisted_users
    }

@app.post("/clear-blacklist")
async def clear_blacklist(request: BlacklistClearRequest):
    global blacklisted_users
    
    if request.clear_all:
        count = len(blacklisted_users)
        blacklisted_users = []
        return {
            "status": "success", 
            "message": f"Cleared all {count} users from blacklist",
            "blacklisted_users": []
        }
    else:
        return {
            "status": "error", 
            "message": "clear_all must be set to true to clear the blacklist",
            "blacklisted_users": blacklisted_users
        }

@app.get("/get-blacklisted-users")
async def get_blacklisted_users():
    global blacklisted_users
    return {"blacklisted_users": blacklisted_users}


@app.post("/set-additional-instructions")
async def set_additional_instructions(prompt_config: AdditionalPromptConfig):
    global additional_instructions
    additional_instructions = prompt_config.additional_instructions
    return {"status": "success", "message": "Additional instructions updated"}

@app.get("/get-additional-instructions")
async def get_additional_instructions():
    return {"additional_instructions": additional_instructions}
@app.get("/ping")
@app.post("/ping")
async def ping():
    """
    Simple ping endpoint for cron-job.org to keep the service alive
    """
    return {
        "status": "alive",
        "timestamp": datetime.now().isoformat(),
        "message": "Service is running"
    }



# New endpoint for heartbeat
@app.post("/heartbeat")
async def heartbeat(request: HeartbeatRequest):
    logger.info(f"Received heartbeat at {request.timestamp}")
    return {"status": "success", "message": "Heartbeat received", "server_time": datetime.now().isoformat()}

def generate_ai_reply(comment: str, post_message: Optional[str] = None, 
                     preset_reply: Optional[str] = None, commenter_name: Optional[str] = None, 
                     commenter_profile_link: Optional[str] = None) -> tuple:
    try:
        time.sleep(2)
        gemini_api_key = os.getenv("GEMINI_API_KEY")
        if not gemini_api_key:
            raise ValueError("Gemini API key not found in environment variables")
            
        genai.configure(api_key=gemini_api_key)
        model = genai.GenerativeModel('gemini-2.0-flash')
        is_bengali = any('\u0980' <= char <= '\u09FF' for char in comment)

        if is_bengali:
            comment_language="bengali"
        else:
            comment_language='others'
            
        # First, check if the comment is offensive or sensitive
        classification_prompt = f"""
        Analyze this comment and determine if it is offensive, religiously sensitive, or aggressive.
        Comment: {comment}
        
        Answer only with 'yes' or 'no'. 
        If the comment contains hate speech, offensive language, religious insults, aggressive behavior, 
        threats, or any content that could be considered harmful, answer 'yes'.
        """
        
        classification_response = model.generate_content(classification_prompt)
        is_offensive = "yes" in classification_response.text.strip().lower()
        
        if is_offensive:
            return "", True  # Return empty reply and flag as offensive
            
        prompt = f"""
        
        আমার  Post:  {post_message}
 person's Comment to my post: {comment}
 Comment language:{comment_language}

Now reply to that as me
        """

        if additional_instructions:
            prompt= f"\n\nAdditional Instructions:\n{additional_instructions}"+prompt
        if preset_reply:
            prompt=prompt+f"including {preset_reply} in the reply "
        time.sleep(2)
        response = model.generate_content(prompt)
        forbidden_phrases = [
                        "since there is no post content",
                        "since there is no comment",
                        "cannot generate reply",
                        "not enough information",
                        "sorry i cannot",
                        "since there is no",
                        "instruction",
                        "reply",
                        "imran sharif",
                        "ইমরান শরীফ ",
                        "i am"
                    ]
        ai_reply = response.text.strip()
        # Check if the AI generated a generic useless reply
        for forbidden_phrase in forbidden_phrases:     
            if forbidden_phrase in ai_reply.lower():
                logger.info(f"AI generated a generic reply, skipping. Detected phrase: {forbidden_phrase}")
                return "", True  # Treat as offensive (skip replying)

        return response.text.strip(), False  # Return reply and flag as not offensive
    except Exception as e:
        logger.error(f"AI reply generation failed: {e}")
        return "", True  # Return empty reply and flag as offensive so no reply if ai fail
        # return "Thank you for your comment", False

@app.post("/add-preset-reply")
def add_preset_reply(preset_data: dict):
    if not preset_data:
        raise HTTPException(status_code=400, detail="No preset data provided")

    global preset_replies
    updated_keys = []
    new_keys = []

    for key, reply in preset_data.items():
        if not key or not reply:
            raise HTTPException(status_code=400, detail="Empty key or reply detected")
            
        if key in preset_replies:
            updated_keys.append(key)
        else:
            new_keys.append(key)
            
        preset_replies[key] = reply

    logger.info(f"Added {len(new_keys)} new preset replies and updated {len(updated_keys)} existing ones")
    return {
        "status": "Success",
        "added": new_keys,
        "updated": updated_keys,
        "total_presets": len(preset_replies)
    }

@app.get("/get-sheet-link/{sheet_id}")
async def get_sheet_link(sheet_id: str):
    return {"sheet_link": f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit"}

def get_facebook_posts(page_id: str, access_token: str) -> List[Dict[str, Any]]:
    url = f"https://graph.facebook.com/v22.0/{page_id}/feed"
    params = {"access_token": access_token, "fields": "id,message,created_time,permalink_url"}
    posts = []
    
    while url:
        try:
            response = requests.get(url, params=params)
            response.raise_for_status()
            data = response.json()
            posts.extend(data.get('data', []))
            url = data.get('paging', {}).get('next', None)
        except requests.exceptions.RequestException as e:
            logger.error(f"Error fetching posts: {e}")
            raise HTTPException(status_code=500, detail=f"Failed to fetch posts: {str(e)}")

    posts.sort(key=lambda x: x.get('created_time', ''), reverse=True)
    return posts

def get_facebook_comments(post_id: str, access_token: str) -> List[Dict[str, Any]]:
    url = f"https://graph.facebook.com/v22.0/{post_id}/comments"
    params = {"access_token": access_token, "fields": "id,message,created_time,permalink_url,from"}
    comments = []
    
    while url:
        try:
            response = requests.get(url, params=params)
            response.raise_for_status()
            data = response.json()
            comments.extend(data.get('data', []))
            url = data.get('paging', {}).get('next', None)
        except requests.exceptions.RequestException as e:
            logger.error(f"Error fetching comments: {e}")
            raise HTTPException(status_code=500, detail=f"Failed to fetch comments: {str(e)}")

    comments.sort(key=lambda x: x.get('created_time', ''), reverse=True)
    return comments

def post_facebook_reply(access_token: str, full_comment_id: str, reply_text: str):
    url = f"https://graph.facebook.com/v22.0/{full_comment_id}/comments"
    params = {"access_token": access_token, "message": reply_text}

    try:
        response = requests.post(url, params=params)
        response.raise_for_status()
        logger.info(f"Reply posted successfully: {response.json()}")
        return response.json()
    except requests.exceptions.RequestException as e:
        logger.error(f"Error posting reply: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to post reply: {str(e)}")
    
def get_page_name(page_id, access_token):
    url = f"https://graph.facebook.com/v12.0/{page_id}"
    params = {'fields': 'name', 'access_token': access_token}
    response = requests.get(url, params=params)
    if response.status_code == 200:
        return response.json().get('name', '[Unknown]')
    else:
        print(f"Error fetching page name: {response.json()}")
        return None

def get_replier_names(full_comment_id, access_token):
    url = f"https://graph.facebook.com/v12.0/{full_comment_id}/comments"
    params = {'fields': 'from', 'access_token': access_token}
    response = requests.get(url, params=params)
    if response.status_code == 200:
        replies = response.json().get('data', [])
        if replies:
            return [reply.get('from', {}).get('name', '[Unknown]') for reply in replies]
        return []
    else:
        print(f"Error fetching replies: {response.status_code} - {response.json()}")
        return 'error'




# Update your request model
class AIReplyRequest(BaseModel):
    config: FacebookConfig
    google_sheet_id: str
    google_credentials: GoogleCredentials
    start_time: str  # Time in HH:MM format (24-hour)
    duration_seconds: int  # How long to run each day

# Helper function to get next occurrence of time in Dhaka timezone
def get_next_dhaka_time(time_str: str):
    """
    Convert time string (HH:MM) to next occurrence in Dhaka timezone
    Returns datetime object in Dhaka timezone
    """
    dhaka_tz = pytz.timezone('Asia/Dhaka')
    
    # Parse the time string
    try:
        hour, minute = map(int, time_str.split(':'))
        if not (0 <= hour <= 23 and 0 <= minute <= 59):
            raise ValueError("Invalid time format")
    except:
        raise ValueError("Time must be in HH:MM format (24-hour)")
    
    # Get current time in Dhaka
    now_dhaka = datetime.now(dhaka_tz)
    
    # Create target time for today
    target_today = now_dhaka.replace(hour=hour, minute=minute, second=0, microsecond=0)
    
    # If target time has passed today, schedule for tomorrow
    if target_today <= now_dhaka:
        target_today += timedelta(days=1)
    
    return target_today

def calculate_seconds_until_dhaka_time(target_time_dhaka):
    """Calculate seconds from now until target time in Dhaka"""
    dhaka_tz = pytz.timezone('Asia/Dhaka')
    now_dhaka = datetime.now(dhaka_tz)
    
    time_diff = target_time_dhaka - now_dhaka
    return int(time_diff.total_seconds())

# Updated process_comments function (same as before but with duration_seconds)
def process_comments(config: FacebookConfig, sheet_id: str, credentials_dict: dict, sheet_name: str, duration_seconds: Optional[int] = None):
    global is_running, blacklisted_users
    ###
    replied_comments = set()
    
    try:
        is_running = True
        # Set a local job_start_time for this execution only
        local_job_start_time = datetime.now()
        # Define cutoff date for posts (March 2025)
        cutoff_date = datetime(2025, 3, 1).isoformat()

        logger.info(f"Starting job execution at {local_job_start_time}")
        
        posts = get_facebook_posts(config.page_id, config.access_token)
        page_name = get_page_name(config.page_id, config.access_token)

        for post in posts:
            # Check if we should stop based on the time elapsed for this execution
            post_time = post.get('created_time', '')
            if post_time < cutoff_date:
                logger.info(f"Skipping post {post['id']} as it's before March 2025")
                continue
                
            # Check duration
            if duration_seconds and datetime.now() >= local_job_start_time + timedelta(seconds=duration_seconds):
                print('Duration time has elapsed')
                logger.info(f"Stopping this job execution due to duration_seconds ({duration_seconds} seconds)")
                return
                
            if not is_running:
                logger.info("Stopping process_comments early due to manual stop")
                return

            post_id = post['id']
            post_message = post.get('message', 'No post content')
            post_permalink_url = post.get('permalink_url', 'No URL')
            post_time = post.get('created_time', 'Unknown')
            try:
                comments = get_facebook_comments(post_id, config.access_token)
            except Exception as e:
                logger.error(f"Error fetching comment for {post_id} continuing")
                continue
            comments.sort(key=lambda x: x.get('created_time', ''), reverse=True)

            for comment in comments:
                # Check duration again
                if duration_seconds and datetime.now() >= local_job_start_time + timedelta(seconds=duration_seconds):
                    logger.info(f"Stopping this job execution due to duration_seconds ({duration_seconds} seconds)")
                    return
                    
                if not is_running:
                    logger.info("Stopping process_comments early due to manual stop")
                    return

                raw_comment_id = comment['id']

                if raw_comment_id in replied_comments:
                    logger.info(f"Skipping already replied comment: {raw_comment_id}")
                    continue
                comment_message = comment.get('message', 'No comment message')
                comment_permalink_url = comment.get('permalink_url', 'No comment URL')
                comment_time = comment.get('created_time', 'Unknown')
                commenter_name = comment.get('from', {}).get('name', 'Anonymous')
                commenter_id = comment.get('from', {}).get('id', '')
                commenter_profile_link = f"https://www.facebook.com/profile.php?id={commenter_id}" if commenter_id else commenter_name

                # Check if user is blacklisted
                is_blacklisted = False
                for blacklisted_user in blacklisted_users:
                    if (blacklisted_user.user_id and blacklisted_user.user_id == commenter_id) or \
                       (blacklisted_user.user_name and blacklisted_user.user_name.lower() == commenter_name.lower()):
                        is_blacklisted = True
                        logger.info(f"Skipping comment by blacklisted user {commenter_name} (ID: {commenter_id})")
                        break
                
                if is_blacklisted:
                    continue
                post_id_cleaned = post_id.split('_')[-1]
                comment_id_cleaned = raw_comment_id.split('_')[-1]
                full_comment_id = f"{config.page_id}_{post_id_cleaned}_{comment_id_cleaned}"
                comment_id_for_reply = raw_comment_id

                replier_names = get_replier_names(comment_id_for_reply, config.access_token)

                time.sleep(2)

                if page_name in replier_names or replier_names == 'error':
                    replied_comments.add(raw_comment_id)   ###
                    continue
                
                preset_reply = preset_replies_check(comment['message'])
                reply_text, is_offensive = generate_ai_reply(
                    comment['message'],
                    post_message,
                    preset_reply,
                    commenter_name,
                    commenter_profile_link
                )
                if is_offensive:
                    logger.info(f"Skipping reply to offensive comment by {commenter_name}: {comment_message[:50]}...")
                    continue
                    
                if reply_text:
                    try: 
                        post_facebook_reply(config.access_token, full_comment_id, reply_text)
                        replied_comments.add(raw_comment_id)
                        store_data_in_sheet({
                            "Post ID": post_id,
                            "Post Content": post_message,
                            "Post URL": post_permalink_url,
                            "Post Time": post_time,
                            "Comment ID": full_comment_id,
                            "Comment Content": comment_message,
                            "Comment URL": comment_permalink_url,
                            "Comment Time": comment_time,
                            "Commenter Name": commenter_name,
                            "Reply": reply_text,
                        }, sheet_id, credentials_dict, sheet_name)
                    except Exception as e:
                        logger.error(f"Failed to post reply or store data: {e}")

    except Exception as e:
        logger.error(f"Error in scheduled task: {e}")
    finally:
        pass

def daily_job_runner(job_id: str, config, google_sheet_id: str, credentials_dict: dict, sheet_name: str, start_time: str, duration_seconds: int):
    """
    Runs the daily recurring job
    """
    dhaka_tz = pytz.timezone('Asia/Dhaka')
    
    while job_id in active_jobs and not stop_flags.get(job_id, False):
        try:
            # Calculate next occurrence
            next_run_time = get_next_dhaka_time(start_time)
            seconds_to_wait = calculate_seconds_until_dhaka_time(next_run_time)
            
            logger.info(f"Job {job_id}: Next run scheduled for {next_run_time.strftime('%Y-%m-%d %H:%M:%S %Z')}")
            logger.info(f"Job {job_id}: Waiting {seconds_to_wait} seconds until next run")
            
            # Wait until it's time to run (check every minute for stop signal)
            start_wait = time.time()
            while time.time() - start_wait < seconds_to_wait:
                if stop_flags.get(job_id, False):
                    logger.info(f"Job {job_id}: Stopped during wait period")
                    return
                time.sleep(60)  # Check every minute
            
            # Check again if job should stop
            if stop_flags.get(job_id, False):
                logger.info(f"Job {job_id}: Stopped before execution")
                return
                
            # Run the job
            current_dhaka_time = datetime.now(dhaka_tz)
            logger.info(f"Job {job_id}: Starting execution at {current_dhaka_time.strftime('%Y-%m-%d %H:%M:%S %Z')}")
            
            process_comments(config, google_sheet_id, credentials_dict, sheet_name, duration_seconds)
            
            logger.info(f"Job {job_id}: Completed execution")
            
        except Exception as e:
            logger.error(f"Error in daily job {job_id}: {e}")
            # Wait a bit before retrying
            time.sleep(300)  # Wait 5 minutes before retry
    
    # Cleanup when job stops
    if job_id in active_jobs:
        del active_jobs[job_id]
    if job_id in stop_flags:
        del stop_flags[job_id]
    logger.info(f"Job {job_id}: Terminated")

@app.post("/start-daily-reply")
def start_daily_reply(request: AIReplyRequest):
    global active_jobs, stop_flags
    
    # Validate time format
    try:
        get_next_dhaka_time(request.start_time)
    except ValueError as e:
        return {"error": f"Invalid time format: {str(e)}"}
    
    # Generate a unique job ID
    job_id = f"daily_{int(time.time())}"
    
    # Create stop flag for this job
    stop_flags[job_id] = False
    
    # Store job info
    active_jobs[job_id] = {
        "start_time": request.start_time,
        "duration_seconds": request.duration_seconds,
        "created_at": datetime.now().isoformat(),
        "config": request.config,
        "google_sheet_id": request.google_sheet_id,
        "sheet_name": request.google_credentials.sheet_name
    }
    
    # Start the daily job thread
    thread = threading.Thread(
        target=daily_job_runner,
        args=(
            job_id,
            request.config,
            request.google_sheet_id,
            request.google_credentials.credentials,
            request.google_credentials.sheet_name,
            request.start_time,
            request.duration_seconds
        )
    )
    thread.daemon = True
    thread.start()
    
    # Calculate next run info for response
    next_run_time = get_next_dhaka_time(request.start_time)
    
    return {
        "status": f"Daily reply bot scheduled for {request.start_time} Dhaka time, running for {request.duration_seconds} seconds each day",
        "job_id": job_id,
        "start_time": request.start_time,
        "duration_seconds": request.duration_seconds,
        "next_run_dhaka": next_run_time.strftime('%Y-%m-%d %H:%M:%S %Z'),
        "sheet_link": f"https://docs.google.com/spreadsheets/d/{request.google_sheet_id}/edit",
        "sheet_name": request.google_credentials.sheet_name
    }

@app.post("/stop-daily-reply")
def stop_daily_reply(job_id: str = None):
    global active_jobs, stop_flags, is_running
    
    if job_id:
        # Stop specific job
        if job_id in active_jobs:
            stop_flags[job_id] = True
            is_running = False
            return {"status": f"Daily job {job_id} stopped"}
        else:
            return {"status": "Job not found"}
    else:
        # Stop all jobs
        for jid in list(active_jobs.keys()):
            stop_flags[jid] = True
        is_running = False
        return {"status": "All daily jobs stopped"}

@app.get("/active-daily-jobs")
def get_active_daily_jobs():
    dhaka_tz = pytz.timezone('Asia/Dhaka')
    current_dhaka_time = datetime.now(dhaka_tz)
    
    job_info = []
    for job_id, job_data in active_jobs.items():
        next_run = get_next_dhaka_time(job_data["start_time"])
        job_info.append({
            "job_id": job_id,
            "start_time": job_data["start_time"],
            "duration_seconds": job_data["duration_seconds"],
            "next_run_dhaka": next_run.strftime('%Y-%m-%d %H:%M:%S %Z'),
            "created_at": job_data["created_at"]
        })
    
    return {
        "active_jobs": job_info,
        "count": len(job_info),
        "current_dhaka_time": current_dhaka_time.strftime('%Y-%m-%d %H:%M:%S %Z')
    }