
import json
import os
from datetime import datetime
from collections import Counter
import pandas as pd

def analyze_commits(directory, repos_data, commits_data):
    all_commits = []
    for filename in os.listdir(directory):
        if filename.endswith(".json"):
            with open(os.path.join(directory, filename), 'r') as f:
                try:
                    data = json.load(f)
                    for commit in data:
                        commit['repo_name'] = filename.replace('.json', '')
                    all_commits.extend(data)
                except json.JSONDecodeError:
                    print(f"Skipping {filename} as it's not a valid JSON file.")


    total_commits = len(all_commits)

    # Activity Analysis
    commits_per_repo = Counter(commit['repo_name'] for commit in all_commits)
    
    dates = [datetime.strptime(commit['commit']['author']['date'], '%Y-%m-%dT%H:%M:%SZ') for commit in all_commits]
    commits_per_day = Counter(date.date() for date in dates)
    commits_per_weekday = Counter(date.strftime('%A') for date in dates)
    commits_per_hour = Counter(date.hour for date in dates)

    # Coding Patterns Analysis
    languages = [repo['language'] for repo in repos_data['items'] if repo['language']]
    language_counts = Counter(languages)

    # Commit message analysis
    commit_types = Counter()
    for commit in all_commits:
        message = commit['commit']['message']
        if ':' in message:
            commit_type = message.split(':')[0].strip()
            if ' ' in commit_type:
                continue
            commit_types[commit_type] += 1
            
    # Commit size analysis
    total_additions = 0
    total_deletions = 0
    
    for commit_sha, commit_data in commits_data.items():
        if "stats" in commit_data:
            total_additions += commit_data['stats']['additions']
            total_deletions += commit_data['stats']['deletions']

    avg_additions = total_additions / len(commits_data) if commits_data else 0
    avg_deletions = total_deletions / len(commits_data) if commits_data else 0


    # Presentation
    report = f"""
# GitHub Coding Patterns and Activity Analysis for fathriAbanoub

## 1. Activity Analysis

### Total Commits
- **Total Commits:** {total_commits}

### Commit Frequency
- **Commits per Day:**
{pd.DataFrame(commits_per_day.most_common(), columns=['Date', 'Commits']).to_markdown(index=False)}

- **Most Active Days of the Week:**
{pd.DataFrame(commits_per_weekday.most_common(), columns=['Day', 'Commits']).to_markdown(index=False)}

- **Most Active Hours of the Day (UTC):**
{pd.DataFrame(commits_per_hour.most_common(), columns=['Hour', 'Commits']).to_markdown(index=False)}

### Most Active Repositories
{pd.DataFrame(commits_per_repo.most_common(), columns=['Repository', 'Commits']).to_markdown(index=False)}

## 2. Coding Patterns Analysis

### Most Frequently Used Languages
{pd.DataFrame(language_counts.most_common(), columns=['Language', 'Repositories']).to_markdown(index=False)}

### Average Commit Size
- **Average Additions per Commit:** {avg_additions:.2f}
- **Average Deletions per Commit:** {avg_deletions:.2f}

### Types of Changes (Based on Conventional Commits)
{pd.DataFrame(commit_types.most_common(), columns=['Commit Type', 'Count']).to_markdown(index=False)}
"""
    return report

if __name__ == '__main__':
    # This is a placeholder for the data that would be passed to the function
    directory = '/home/bobaayad/.gemini/tmp/ambient-studio/commits/'
    
    repos_data = { "total_count": 31, "incomplete_results": False, "items": [ { "id": 727623623, "name": "picture", "full_name": "fathriAbanoub/picture", "html_url": "https://github.com/fathriAbanoub/picture", "stargazers_count": 1, "forks_count": 0, "open_issues_count": 0, "updated_at": "2023-12-05T08:51:32Z", "created_at": "2023-12-05T08:38:43Z", "private": False, "fork": False, "archived": False, "default_branch": "main" }, { "id": 809055105, "name": "note", "full_name": "fathriAbanoub/note", "html_url": "https://github.com/fathriAbanoub/note", "language": "Dart", "stargazers_count": 1, "forks_count": 0, "open_issues_count": 0, "updated_at": "2024-06-08T12:14:38Z", "created_at": "2024-06-01T15:01:02Z", "private": False, "fork": False, "archived": False, "default_branch": "main" }, { "id": 896710166, "name": "vk-subtitle-extractor", "full_name": "fathriAbanoub/vk-subtitle-extractor", "html_url": "https://github.com/fathriAbanoub/vk-subtitle-extractor", "language": "Python", "stargazers_count": 1, "forks_count": 0, "open_issues_count": 0, "updated_at": "2025-05-05T06:27:31Z", "created_at": "2024-12-01T05:02:39Z", "private": False, "fork": False, "archived": False, "default_branch": "main" }, { "id": 744364603, "name": "Adversarial-Image-Generation-using-FGSM", "full_name": "fathriAbanoub/Adversarial-Image-Generation-using-FGSM", "html_url": "https://github.com/fathriAbanoub/Adversarial-Image-Generation-using-FGSM", "stargazers_count": 0, "forks_count": 0, "open_issues_count": 0, "updated_at": "2024-01-17T06:30:54Z", "created_at": "2024-01-17T06:30:54Z", "private": False, "fork": False, "archived": False, "default_branch": "main" }, { "id": 969732859, "name": "vite-react", "full_name": "fathriAbanoub/vite-react", "html_url": "https://github.com/fathriAbanoub/vite-react", "language": "CSS", "stargazers_count": 0, "forks_count": 0, "open_issues_count": 0, "updated_at": "2025-04-20T20:11:58Z", "created_at": "2025-04-20T20:11:22Z", "private": True, "fork": False, "archived": False, "default_branch": "main" }]}
    
    commits_data = {{
        "732db35dff8b130ad1ebf9727f85be46477c6618": {{"stats": {{"additions": 28, "deletions": 1, "total": 29}}}},
        "e093ef885dd88a3fa7684e309643517379581f7d": {{"stats": {{"additions": 171, "total": 171}}}},
        "508de52c2694687080896c277842a40cfecc7983": {{"stats": {{"additions": 24283, "total": 24283}}}},
        "837cd484efd64822c9c7e706087c5bbbe49e419d": {{"stats": {{"additions": 7501, "total": 7501}}}},
        "29cd5b6e909acee34f851b52d0c7860267813c50": {{"stats": {{"additions": 1879573, "total": 1879573}}}},
        "614b97bde76bb2940fe2fd64b6b8f50f1465eab6": {{"stats": {{"additions": 71, "total": 71}}}},
        "1ab0e0930d5a73c9f3ac693eccedf098fbbe3ad4": {{"stats": {{"additions": 1, "total": 1}}}},
        "cddefa9ab21661a8e6dbbf844a75f08bf26dcb0f": {{"stats": {{"additions": 1, "deletions": 40, "total": 41}}}},
        "3b2e47c6d1b762ee693b867065ca680f7edbf57f": {{"stats": {{"additions": 637, "deletions": 427, "total": 1064}}}},
        "a9f3699e126907e6580bab495fbad07f3e0d75b3": {{"stats": {{"additions": 140, "total": 140}}}}
    }}

    report = analyze_commits(directory, repos_data, commits_data)
    print(report)

